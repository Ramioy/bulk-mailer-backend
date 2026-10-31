import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ZeptoMailEmailProvider } from '../../src/adapters/outbound/zeptomail/zeptomail-email-provider';
import type { OutgoingEmail } from '../../src/ports/email-provider';
import { createZeptoMailMock, type ZeptoMailMockOptions } from '../../mocks/zeptomail-api';
import { pdfBytes } from '../support/receipt-fixtures';

const email = (attemptId: string, to = 'admin@altos.com', copyTo?: string): OutgoingEmail => ({
  attemptId,
  to,
  copyTo,
  subject: 'Multa – Octubre 2026',
  textBody: 'Señores Edificio Altos:',
  attachment: { name: 'Edificio Altos CNCPT MULTA CNTRT 104522.pdf', content: pdfBytes(attemptId) },
});

/** Independent check of the documented validator: split at the first `=`, decode the value, base64 HMAC-SHA256. */
function verify(body: string, signatureHeader: string, key: string): { valid: boolean; ts: number; json: string } {
  const parts = Object.fromEntries(signatureHeader.split(';').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const json = decodeURIComponent(body.slice(body.indexOf('=') + 1));
  const expected = createHmac('sha256', key).update(json, 'utf8').digest();
  const given = Buffer.from(decodeURIComponent(String(parts.s)), 'base64');
  return { valid: parts['s-algorithm'] === 'HmacSHA256' && given.length === expected.length && timingSafeEqual(given, expected), ts: Number(parts.ts), json };
}

async function startMock(options: Partial<ZeptoMailMockOptions> = {}) {
  const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
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
    oauthToken: 'oauth-1',
    webhook: {
      url: `http://127.0.0.1:${(receiver.server.address() as AddressInfo).port}/webhooks/zeptomail`,
      authenticationKey: 'hmac-key',
      authorization: { name: 'Authorization', value: 'Webhook-secret s3cr3t' },
    },
    ...options,
  });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}/v1.1`;
  const provider = new ZeptoMailEmailProvider({ baseUrl, apiKey: 'agent-key', from: { address: 'soportes@anutibara.com' }, timeoutMs: 500 });
  const logs = (path: string, token = 'oauth-1') => fetch(`${baseUrl}${path}`, { headers: { authorization: `Zoho-oauthtoken ${token}` } });
  return {
    mock,
    provider,
    logs,
    received,
    close: async () => {
      await mock.close();
      await receiver.close();
    },
  };
}

describe('ZeptoMail simulator: logs API', () => {
  let env: Awaited<ReturnType<typeof startMock>>;
  beforeAll(async () => {
    env = await startMock();
  });
  afterAll(() => env.close());

  it('requires the OAuth token', async () => {
    expect((await env.logs('/email?client_reference=x', 'wrong')).status).toBe(401);
  });

  it('lists one entry per recipient by client_reference, without client_reference in the list', async () => {
    await env.provider.send(email('attempt-list', 'admin@altos.com', 'archivo@anutibara.com'));
    const response = await env.logs('/email?client_reference=attempt-list');
    const body = (await response.json()) as { data: Array<Record<string, unknown>>; status: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.data.map((d) => d.to)).toEqual(['admin@altos.com', 'archivo@anutibara.com']);
    expect(body.data[0]).toMatchObject({ status: 'processed', subject: 'Multa – Octubre 2026', from: 'soportes@anutibara.com' });
    expect(body.data[0]).not.toHaveProperty('client_reference');
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual(['email_reference', 'from', 'mailagent_key', 'request_id', 'sent_time', 'status', 'subject', 'to']);
  });

  it('returns the client_reference in the specific-email response', async () => {
    const list = (await (await env.logs('/email?client_reference=attempt-list')).json()) as { data: Array<{ email_reference: string }> };
    const reference = list.data[0]?.email_reference ?? '';
    const detail = (await (await env.logs(`/email/email-reference/${reference}`)).json()) as { data: Record<string, unknown> };
    expect(detail.data).toMatchObject({ email_reference: reference, client_reference: 'attempt-list', to: 'admin@altos.com' });
  });

  it('answers EL_404 as documented: 400 on the list, 404 on the specific email', async () => {
    const list = await env.logs('/email?client_reference=never-sent');
    expect(list.status).toBe(400);
    expect(await list.json()).toEqual({ error: { code: 'EL_404', message: 'Email log not found' }, status: 'failure' });
    expect((await env.logs('/email/email-reference/nope')).status).toBe(404);
  });

  it('shows the email of a timed-out send (the response was lost, the email went out)', async () => {
    const slow = await startMock({ timeoutMs: 700 });
    try {
      expect((await slow.provider.send(email('attempt-timeout', 'admin+zm-timeout@altos.com'))).kind).toBe('UNCERTAIN');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await slow.logs('/email?client_reference=attempt-timeout')).status).toBe(200);
    } finally {
      await slow.close();
    }
  });

  it('never shows a reset send or a nolog send', async () => {
    await env.provider.send(email('attempt-reset', 'admin+zm-reset@altos.com'));
    await env.provider.send(email('attempt-nolog', 'admin+zm-nolog@altos.com'));
    expect((await env.logs('/email?client_reference=attempt-reset')).status).toBe(400);
    expect((await env.logs('/email?client_reference=attempt-nolog')).status).toBe(400);
  });

  it('simulates the undocumented log delay and a partial client_reference match', async () => {
    let now = new Date('2026-10-31T15:00:00Z');
    const delayed = await startMock({ logDelayMs: 60_000, clientReferenceMatch: 'partial', now: () => now });
    try {
      await delayed.provider.send(email('a1b2c3-0001'));
      expect((await delayed.logs('/email?client_reference=a1b2c3-0001')).status).toBe(400);
      now = new Date('2026-10-31T15:01:00Z');
      expect((await delayed.logs('/email?client_reference=a1b2c3')).status).toBe(200);
    } finally {
      await delayed.close();
    }
  });
});

describe('ZeptoMail simulator: webhooks', () => {
  let env: Awaited<ReturnType<typeof startMock>>;
  beforeAll(async () => {
    env = await startMock();
  });
  afterAll(() => env.close());

  it('posts the event as a single form-encoded parameter, signed as documented, with the custom Authorization header', async () => {
    await env.provider.send(email('attempt-hb'));
    const sent = await env.mock.emit('attempt-hb', 'hardbounce');
    expect(sent?.response).toBe(200);
    const request = env.received.at(-1);
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.headers.authorization).toBe('Webhook-secret s3cr3t');
    const check = verify(request?.body ?? '', String(request?.headers['producer-signature']), 'hmac-key');
    expect(check.valid).toBe(true);
    expect(Math.abs(Date.now() - check.ts)).toBeLessThan(5_000);
    expect(verify(request?.body ?? '', String(request?.headers['producer-signature']), 'other-key').valid).toBe(false);

    const payload = JSON.parse(check.json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event_name: ['hardbounce'],
      event_message: [
        {
          email_info: { client_reference: 'attempt-hb', to: [{ email_address: { address: 'admin@altos.com' } }], object: 'email' },
          event_data: [{ object: 'hardbounce', details: [{ bounced_recipient: 'admin@altos.com', diagnostic_message: '550 5.1.1 User unknown' }] }],
        },
      ],
      mailagent_key: 'mock-agent',
      webhook_request_id: expect.any(String),
    });
    const log = (await (await env.logs('/email?client_reference=attempt-hb')).json()) as { data: Array<{ status: string }> };
    expect(log.data[0]?.status).toBe('hard bounce');
  });

  it('keeps the signature valid for payloads with "+" and accents (only the value is decoded)', async () => {
    await env.provider.send(email('attempt+plus', 'a+b@altos.com'));
    await env.mock.emit('attempt+plus', 'delivered');
    const request = env.received.at(-1);
    const check = verify(request?.body ?? '', String(request?.headers['producer-signature']), 'hmac-key');
    expect(check.valid).toBe(true);
    expect(JSON.parse(check.json)).toMatchObject({ event_name: ['email_delivered'], event_message: [{ email_info: { client_reference: 'attempt+plus' } }] });
  });

  it('reports the complaint with fblFrom and the archive copy as its own recipient', async () => {
    await env.provider.send(email('attempt-copy', 'admin@altos.com', 'archivo@anutibara.com'));
    await env.mock.emit('attempt-copy', 'complaint');
    expect(env.mock.webhooks.at(-1)?.payload).toMatchObject({
      event_message: [{ event_data: [{ object: 'fbl_complaint', details: [{ fblFrom: 'admin@altos.com' }] }] }],
    });
    await env.mock.emit('attempt-copy', 'hardbounce', { recipient: 'bcc' });
    expect(env.mock.webhooks.at(-1)?.payload).toMatchObject({
      event_message: [{ email_info: { bcc: [{ email_address: { address: 'archivo@anutibara.com' } }] }, event_data: [{ details: [{ bounced_recipient: 'archivo@anutibara.com' }] }] }],
    });
  });

  it('gives every webhook transaction its own webhook_request_id', () => {
    const ids = env.mock.webhooks.map((w) => w.webhookRequestId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ZeptoMail simulator: automatic delivery scenarios', () => {
  let env: Awaited<ReturnType<typeof startMock>>;
  beforeAll(async () => {
    env = await startMock({ autoEvents: { delayMs: 0 } });
  });
  afterAll(() => env.close());

  const objects = (attemptId: string) =>
    env.mock.webhooks
      .filter((w) => JSON.stringify(w.payload).includes(`"client_reference":"${attemptId}"`))
      .map((w) => (w.payload.event_name as string[])[0]);
  const status = async (attemptId: string) =>
    ((await (await env.logs(`/email?client_reference=${encodeURIComponent(attemptId)}`)).json()) as { data: Array<{ status: string }> }).data.map((d) => d.status);

  it.each([
    ['admin@altos.com', ['email_delivered'], ['delivered']],
    ['admin+zm-softhard@altos.com', ['softbounce', 'hardbounce'], ['hard bounce']],
    ['admin+zm-softdelivered@altos.com', ['softbounce', 'email_delivered'], ['delivered']],
    ['admin+zm-complaint@altos.com', ['email_delivered', 'fbl_complaint'], ['delivered']],
    ['admin+zm-processfailed@altos.com', [], ['process failed']],
    ['admin+zm-nowebhook@altos.com', [], ['delivered']],
  ])('%s → webhooks %j, log status %j', async (to, events, logStatus) => {
    const attemptId = `auto-${to.split('@')[0]}`;
    await env.provider.send(email(attemptId, to));
    await env.mock.settle();
    expect(objects(attemptId)).toEqual(events);
    expect(await status(attemptId)).toEqual(logStatus);
  });

  it('delivers the archive copy on its own', async () => {
    await env.provider.send(email('auto-copy', 'admin+zm-hardbounce@altos.com', 'archivo@anutibara.com'));
    await env.mock.settle();
    expect(await status('auto-copy')).toEqual(['hard bounce', 'delivered']);
  });
});
