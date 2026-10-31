import { createServer, type AddressInfo } from 'node:net';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseZeptoMailWebhook, verifyZeptoMailWebhook, type ZeptoMailWebhookSecrets } from '../../src/adapters/inbound/webhooks/zeptomail-webhook';
import { RedirectingSendLookup } from '../../src/adapters/outbound/zeptomail/redirecting-send-lookup';
import { ZeptoMailConsoleSuppressionManager } from '../../src/adapters/outbound/zeptomail/zeptomail-console-suppression-manager';
import { ZeptoMailEmailProvider } from '../../src/adapters/outbound/zeptomail/zeptomail-email-provider';
import { ZeptoMailSendLookup } from '../../src/adapters/outbound/zeptomail/zeptomail-send-lookup';
import { ZohoOAuthTokenProvider } from '../../src/adapters/outbound/zeptomail/zoho-oauth';
import type { OutgoingEmail } from '../../src/ports/email-provider';
import type { SendLookup } from '../../src/ports/send-lookup';
import { createZeptoMailMock, signWebhook, type ZeptoMailMockOptions } from '../../mocks/zeptomail-api';
import { pdfBytes } from '../support/receipt-fixtures';

const CLIENT = { clientId: 'client-1', clientSecret: 'secret-1', refreshToken: 'refresh-1' };
const SECRETS: ZeptoMailWebhookSecrets = { authenticationKey: 'hmac-key', authorizationHeader: 'authorization', authorizationValue: 'Webhook s3cr3t', maxSkewSeconds: 300 };

/** A local port nobody listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const email = (attemptId: string, to = 'admin@altos.com', copyTo?: string): OutgoingEmail => ({
  attemptId,
  to,
  copyTo,
  subject: 'Multa – Octubre 2026',
  textBody: 'Señores Edificio Altos:',
  attachment: { name: 'Edificio Altos CNCPT MULTA CNTRT 104522.pdf', content: pdfBytes(attemptId) },
});

async function start(options: Partial<ZeptoMailMockOptions> = {}) {
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const receiver = Fastify();
  receiver.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  receiver.post('/webhooks/zeptomail', async (request) => {
    received.push({ headers: request.headers, body: String(request.body) });
    return {};
  });
  await receiver.listen({ port: 0, host: '127.0.0.1' });
  const mock = createZeptoMailMock({
    apiKey: 'agent-key',
    verifiedDomains: ['anutibara.com'],
    oauthToken: 'access-1',
    oauthClient: CLIENT,
    webhook: {
      url: `http://127.0.0.1:${(receiver.server.address() as AddressInfo).port}/webhooks/zeptomail`,
      authenticationKey: SECRETS.authenticationKey,
      authorization: { name: 'Authorization', value: SECRETS.authorizationValue },
    },
    ...options,
  });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
  const baseUrl = `${origin}/v1.1`;
  const sender = new ZeptoMailEmailProvider({ baseUrl, apiKey: 'agent-key', from: { address: 'soportes@anutibara.com' }, timeoutMs: 500 });
  const tokens = new ZohoOAuthTokenProvider({ accountsUrl: origin, ...CLIENT, timeoutMs: 1000 });
  const lookup = new ZeptoMailSendLookup({ baseUrl, timeoutMs: 1000 }, tokens);
  return {
    mock,
    origin,
    baseUrl,
    sender,
    tokens,
    lookup,
    received,
    close: async () => {
      await mock.close();
      await receiver.close();
    },
  };
}

describe('ZohoOAuthTokenProvider', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    env = await start();
  });
  afterAll(() => env.close());

  it('gets an access token with the refresh-token grant and caches it until shortly before expiry', async () => {
    let now = Date.parse('2026-10-31T10:00:00Z');
    const tokens = new ZohoOAuthTokenProvider({ accountsUrl: env.origin, ...CLIENT, timeoutMs: 1000, now: () => now });
    const before = env.mock.tokensIssued();
    expect(await tokens.token()).toBe('access-1');
    expect(await tokens.token()).toBe('access-1');
    expect(env.mock.tokensIssued() - before).toBe(1);
    now += 59 * 60_000 + 1;
    await tokens.token();
    expect(env.mock.tokensIssued() - before).toBe(2);
  });

  it('reports a refused client or an unreachable server as an error, without throwing', async () => {
    const wrong = new ZohoOAuthTokenProvider({ accountsUrl: env.origin, ...CLIENT, clientSecret: 'nope', timeoutMs: 1000 });
    expect(await wrong.token()).toEqual({ error: 'OAuth token: HTTP 200 invalid_client' });
    const down = new ZohoOAuthTokenProvider({ accountsUrl: `http://127.0.0.1:${await closedPort()}`, ...CLIENT, timeoutMs: 1000 });
    expect(await down.token()).toEqual({ error: expect.stringContaining('ECONNREFUSED') });
  });
});

describe('ZeptoMailSendLookup against the simulated logs API', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    env = await start();
  });
  afterAll(() => env.close());

  it('answers NOT_FOUND for a send the provider never received (EL_404)', async () => {
    await env.sender.send(email('lost-reset', 'admin+zm-reset@altos.com'));
    expect(await env.lookup.findByAttempt('lost-reset', 'admin+zm-reset@altos.com')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('finds the primary recipient’s entry, confirmed by its client reference, with request id and email reference', async () => {
    await env.sender.send(email('att-1', 'admin@altos.com', 'archivo@anutibara.com'));
    const sent = env.mock.deliveries.filter((d) => d.clientReference === 'att-1');
    await env.mock.emit('att-1', 'hardbounce', { recipient: 'bcc', webhook: false });
    expect(await env.lookup.findByAttempt('att-1', 'admin@altos.com')).toEqual({
      kind: 'FOUND',
      status: 'PROCESSED',
      providerRequestId: sent[0]?.requestId,
      emailReference: sent[0]?.emailReference,
      detail: 'processed',
    });
    await env.mock.emit('att-1', 'delivered', { webhook: false });
    expect(await env.lookup.findByAttempt('att-1', 'ADMIN@altos.com')).toMatchObject({ kind: 'FOUND', status: 'DELIVERED' });
  });

  it.each([
    ['softbounce', 'SOFT_BOUNCE'],
    ['hardbounce', 'HARD_BOUNCE'],
    ['processfailed', 'PROCESS_FAILED'],
  ] as const)('maps the log status after %s to %s', async (event, status) => {
    await env.sender.send(email(`att-${event}`));
    await env.mock.emit(`att-${event}`, event, { webhook: false });
    expect(await env.lookup.findByAttempt(`att-${event}`, 'admin@altos.com')).toMatchObject({ kind: 'FOUND', status });
  });

  it('finds a send whose response was lost (timeout): the email did go out', async () => {
    const slow = await start({ timeoutMs: 700 });
    try {
      expect((await slow.sender.send(email('att-timeout', 'admin+zm-timeout@altos.com'))).kind).toBe('UNCERTAIN');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await slow.lookup.findByAttempt('att-timeout', 'admin+zm-timeout@altos.com')).toMatchObject({ kind: 'FOUND', status: 'PROCESSED' });
    } finally {
      await slow.close();
    }
  });

  it('ignores another send whose client reference only contains ours (partial match, §12.7)', async () => {
    const partial = await start({ clientReferenceMatch: 'partial' });
    try {
      await partial.sender.send(email('ref-1-other'));
      expect(await partial.lookup.findByAttempt('ref-1', 'admin@altos.com')).toEqual({ kind: 'NOT_FOUND' });
      await partial.sender.send(email('ref-1'));
      expect(await partial.lookup.findByAttempt('ref-1', 'admin@altos.com')).toMatchObject({ kind: 'FOUND' });
    } finally {
      await partial.close();
    }
  });

  it('encodes the client reference in the URL', async () => {
    await env.sender.send(email('a+b c'));
    expect(await env.lookup.findByAttempt('a+b c', 'admin@altos.com')).toMatchObject({ kind: 'FOUND' });
  });

  it('renews the token once on a 401 and is UNAVAILABLE (never NOT_FOUND) when the logs cannot be read', async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 401 }) : fetch(input, init);
    };
    const lookup = new ZeptoMailSendLookup({ baseUrl: env.baseUrl, timeoutMs: 1000, fetch: flaky }, env.tokens);
    expect(await lookup.findByAttempt('never', 'admin@altos.com')).toEqual({ kind: 'NOT_FOUND' });

    const noAuth = new ZeptoMailSendLookup({ baseUrl: env.baseUrl, timeoutMs: 1000 }, new ZohoOAuthTokenProvider({ accountsUrl: env.origin, ...CLIENT, refreshToken: 'x', timeoutMs: 1000 }));
    expect(await noAuth.findByAttempt('never', 'admin@altos.com')).toEqual({ kind: 'UNAVAILABLE', detail: 'OAuth token: HTTP 200 invalid_code' });
    const down = new ZeptoMailSendLookup({ baseUrl: `http://127.0.0.1:${await closedPort()}/v1.1`, timeoutMs: 1000 }, env.tokens);
    expect(await down.findByAttempt('never', 'admin@altos.com')).toMatchObject({ kind: 'UNAVAILABLE', detail: expect.stringContaining('ECONNREFUSED') });
    const html: typeof fetch = async () => new Response('<html>', { status: 502 });
    expect(await new ZeptoMailSendLookup({ baseUrl: env.baseUrl, timeoutMs: 1000, fetch: html }, env.tokens).findByAttempt('x', 'a@b.co')).toEqual({
      kind: 'UNAVAILABLE',
      detail: 'logs API HTTP 502',
    });
  });

  it('does not resolve an undocumented status', async () => {
    const odd: typeof fetch = async (input) =>
      String(input).includes('email-reference')
        ? Response.json({ data: { email_reference: 'r', client_reference: 'x', to: 'a@b.co', status: 'deferred' }, status: 'success' })
        : Response.json({ data: [{ email_reference: 'r', to: 'a@b.co', status: 'deferred' }], status: 'success' });
    const lookup = new ZeptoMailSendLookup({ baseUrl: env.baseUrl, timeoutMs: 1000, fetch: odd }, env.tokens);
    expect(await lookup.findByAttempt('x', 'a@b.co')).toEqual({ kind: 'UNAVAILABLE', detail: 'logs API: undocumented status "deferred"' });
  });

  it('outside production, looks the send up in the test mailbox', async () => {
    const calls: string[] = [];
    const inner: SendLookup = { findByAttempt: async (_id, recipient) => (calls.push(recipient), { kind: 'NOT_FOUND' }) };
    await new RedirectingSendLookup(inner, 'pruebas@anutibara.com').findByAttempt('a', 'admin@altos.com');
    expect(calls).toEqual(['pruebas@anutibara.com']);
  });
});

describe('ZeptoMail webhooks: verification and parsing', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    env = await start();
  });
  afterAll(() => env.close());

  const lastRequest = () => env.received.at(-1) as { headers: Record<string, string | string[] | undefined>; body: string };

  it('accepts a webhook signed by the simulator and reads its events', async () => {
    await env.sender.send(email('att-w1', 'admin@altos.com', 'archivo@anutibara.com'));
    await env.mock.emit('att-w1', 'hardbounce');
    const { headers, body } = lastRequest();
    const verified = verifyZeptoMailWebhook(headers, body, new Date(), SECRETS);
    expect(verified.ok).toBe(true);
    const parsed = parseZeptoMailWebhook(verified.ok ? verified.json : '', new Date());
    const sent = env.mock.deliveries.find((d) => d.clientReference === 'att-w1');
    expect(parsed).toEqual({
      webhookRequestId: env.mock.webhooks.at(-1)?.webhookRequestId,
      events: [
        expect.objectContaining({
          attemptId: 'att-w1',
          recipient: 'admin@altos.com',
          state: 'HARD_BOUNCE',
          reason: 'Mailbox does not exist — 550 5.1.1 User unknown',
          source: 'WEBHOOK',
          providerRequestId: sent?.requestId,
          emailReference: sent?.emailReference,
        }),
      ],
    });
  });

  it.each([
    ['delivered', 'ACCEPTED', 'admin@altos.com'],
    ['softbounce', 'SOFT_BOUNCE', 'admin@altos.com'],
    ['complaint', 'COMPLAINT', 'admin@altos.com'],
  ] as const)('reads %s as %s with its recipient', async (event, state, recipient) => {
    await env.sender.send(email(`att-${event}`, 'admin@altos.com', 'archivo@anutibara.com'));
    await env.mock.emit(`att-${event}`, event);
    const { headers, body } = lastRequest();
    const verified = verifyZeptoMailWebhook(headers, body, new Date(), SECRETS);
    expect(parseZeptoMailWebhook(verified.ok ? verified.json : '', new Date()).events).toEqual([expect.objectContaining({ state, recipient })]);
  });

  it('reads the archive copy’s bounce with the copy as recipient', async () => {
    await env.sender.send(email('att-copy', 'admin@altos.com', 'archivo@anutibara.com'));
    await env.mock.emit('att-copy', 'hardbounce', { recipient: 'bcc' });
    const { headers, body } = lastRequest();
    const verified = verifyZeptoMailWebhook(headers, body, new Date(), SECRETS);
    expect(parseZeptoMailWebhook(verified.ok ? verified.json : '', new Date()).events[0]).toMatchObject({ recipient: 'archivo@anutibara.com' });
  });

  it('rejects a wrong authorization header, a tampered body, another algorithm or a stale timestamp', async () => {
    await env.sender.send(email('att-bad'));
    await env.mock.emit('att-bad', 'delivered');
    const { headers, body } = lastRequest();
    const now = new Date();
    expect(verifyZeptoMailWebhook({ ...headers, authorization: 'Webhook other' }, body, now, SECRETS)).toEqual({ ok: false, reason: 'authorization header' });
    expect(verifyZeptoMailWebhook({ ...headers, authorization: undefined }, body, now, SECRETS)).toEqual({ ok: false, reason: 'authorization header' });
    expect(verifyZeptoMailWebhook(headers, body.replace('delivered', 'hardbounce'), now, SECRETS)).toEqual({ ok: false, reason: 'signature' });
    const signature = String(headers['producer-signature']);
    expect(verifyZeptoMailWebhook({ ...headers, 'producer-signature': signature.replace('HmacSHA256', 'HmacSHA1') }, body, now, SECRETS)).toEqual({
      ok: false,
      reason: 'signature algorithm',
    });
    expect(verifyZeptoMailWebhook(headers, body, new Date(now.getTime() + 6 * 60_000), SECRETS)).toEqual({ ok: false, reason: 'signature timestamp' });
    expect(verifyZeptoMailWebhook(headers, body, now, { ...SECRETS, authenticationKey: 'other' })).toEqual({ ok: false, reason: 'signature' });
  });

  it('uses the configured name of the custom authorization header', () => {
    const json = '{"webhook_request_id":"w"}';
    const headers = { 'x-bulk-mailer': 'k', 'producer-signature': signWebhook(json, 'hmac-key', Date.now()) };
    const body = `data=${encodeURIComponent(json)}`;
    expect(verifyZeptoMailWebhook(headers, body, new Date(), { ...SECRETS, authorizationHeader: 'X-Bulk-Mailer', authorizationValue: 'k' })).toEqual({ ok: true, json });
  });

  it('tolerates objects instead of arrays, ignores opens and clicks, and drops events without client reference', () => {
    const at = new Date('2026-10-31T12:00:00Z');
    const payload = {
      event_name: 'hard bounce',
      event_message: {
        email_info: { client_reference: 'att-x', to: [{ email_address: { address: 'Admin@Altos.com' } }] },
        event_data: { object: 'hardbounce', details: { reason: 'gone', time: '2026-10-31T11:59:00Z' } },
        request_id: 'req',
      },
      webhook_request_id: 'w-obj',
    };
    expect(parseZeptoMailWebhook(JSON.stringify(payload), at)).toEqual({
      webhookRequestId: 'w-obj',
      events: [
        {
          eventId: 'w-obj:0:0:0',
          attemptId: 'att-x',
          recipient: 'admin@altos.com',
          state: 'HARD_BOUNCE',
          reason: 'gone',
          occurredAt: new Date('2026-10-31T11:59:00Z'),
          source: 'WEBHOOK',
          providerRequestId: 'req',
        },
      ],
    });
    const open = { event_name: ['email_open'], event_message: [{ email_info: { client_reference: 'a' }, event_data: [{ object: 'email_open' }] }], webhook_request_id: 'w' };
    expect(parseZeptoMailWebhook(JSON.stringify(open), at).events).toEqual([]);
    // D45: why each message was dropped; opens and clicks only are not worth an alert.
    expect(parseZeptoMailWebhook(JSON.stringify(open), at).notes).toEqual({ eventNames: ['email_open'], dropped: [{ index: '0.0', reason: 'not a delivery event: "email_open"' }], onlyIgnorable: true });
    const anonymous = { event_message: [{ email_info: {}, event_data: [{ object: 'hardbounce' }] }], webhook_request_id: 'w' };
    expect(parseZeptoMailWebhook(JSON.stringify(anonymous), at).events).toEqual([]);
    expect(parseZeptoMailWebhook(JSON.stringify(anonymous), at).notes).toEqual({ eventNames: [], dropped: [{ index: '0', reason: 'no email_info.client_reference' }], onlyIgnorable: false });
    expect(parseZeptoMailWebhook('not json', at)).toEqual({ events: [], notes: { eventNames: [], dropped: [{ index: 'body', reason: 'not JSON' }], onlyIgnorable: false } });
    const unknown = { event_name: ['mystery'], event_message: [{ email_info: { client_reference: 'a' }, event_data: [{ object: 'mail_queued' }] }], webhook_request_id: 'w' };
    expect(parseZeptoMailWebhook(JSON.stringify(unknown), at).notes).toEqual({ eventNames: ['mystery', 'mail_queued'], dropped: [{ index: '0.0', reason: 'unknown event "mail_queued"' }], onlyIgnorable: false });
  });

  it('outside production, the test mailbox does not identify the recipient', () => {
    const payload = {
      event_message: [{ email_info: { client_reference: 'a', to: [{ email_address: { address: 'pruebas@anutibara.com' } }] }, event_data: [{ object: 'softbounce', details: [{ bounced_recipient: 'pruebas@anutibara.com' }] }] }],
      webhook_request_id: 'w',
    };
    expect(parseZeptoMailWebhook(JSON.stringify(payload), new Date(), 'pruebas@anutibara.com').events[0]?.recipient).toBeUndefined();
  });
});

describe('ZeptoMailConsoleSuppressionManager (D19)', () => {
  it('asks for the operator’s confirmation and calls nothing', async () => {
    const manager = new ZeptoMailConsoleSuppressionManager();
    expect(manager.confirmation).toBe('OPERATOR');
    expect(await manager.release('admin@altos.com')).toEqual({ ok: true, value: 'CONFIRMED_BY_OPERATOR' });
  });
});
