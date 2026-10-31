import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ZeptoMailEmailProvider } from '../src/adapters/outbound/zeptomail/zeptomail-email-provider';
import { ZeptoMailSendLookup } from '../src/adapters/outbound/zeptomail/zeptomail-send-lookup';
import { ZohoOAuthTokenProvider } from '../src/adapters/outbound/zeptomail/zoho-oauth';
import { createZeptoMailMock, signWebhook, type ZeptoMailMock } from '../mocks/zeptomail-api';
import { OCT_2026 } from './support/builders';
import { fileName, pdfBytes } from './support/receipt-fixtures';
import { startTestApp, TEST_PASSWORD, WEBHOOK_SECRETS, type TestContext } from './support/test-app';

const BOUNDARY = 'b0undary';
const HOUR = 3_600_000;

function multipart(files: Array<{ name: string; content: Uint8Array }>): Buffer {
  return Buffer.concat([
    ...files.flatMap(({ name, content }) => [
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(content),
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

describe('delivery over HTTP', () => {
  let ctx: TestContext;
  let mock: ZeptoMailMock | undefined;

  afterEach(async () => {
    await ctx.app.close();
    await mock?.close();
    mock = undefined;
  });

  const signIn = async () =>
    (await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username: 'operador', password: TEST_PASSWORD } })).json().accessToken as string;
  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: object) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  /** Uploads one receipt, sends it and lets the background work and the outbox run. */
  async function sendOne(token: string, seed = 'r1') {
    await ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/receipts',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart([{ name: fileName(`Torre ${seed}`, 'MULTA', '104522'), content: pdfBytes(seed) }]),
    });
    const version = (await call('GET', '/batches/2026-10/CASH', token)).json().manifestVersion;
    await call('POST', '/batches/2026-10/CASH/executions', token, { manifestVersion: version });
    await settle();
    return (await ctx.repository.receipts.listByBatch(OCT_2026, 'CASH')).find((r) => r.fileName === fileName(`Torre ${seed}`, 'MULTA', '104522'));
  }

  /** Runs the outbox and the job queue until both are idle. */
  async function settle() {
    for (let round = 0; round < 5; round += 1) {
      await ctx.relay.drain();
      await ctx.runner.drain();
    }
  }

  const postWebhook = (json: string, ts = ctx.clock.now().getTime(), extra: Record<string, string> = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/webhooks/zeptomail',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: WEBHOOK_SECRETS.authorizationValue,
        'producer-signature': signWebhook(json, WEBHOOK_SECRETS.authenticationKey, ts),
        ...extra,
      },
      payload: `data=${encodeURIComponent(json)}`,
    });

  const hardBounce = (attemptId: string, id = 'wr-1') =>
    JSON.stringify({
      event_name: ['hardbounce'],
      event_message: [
        {
          email_info: { client_reference: attemptId, to: [{ email_address: { address: 'admin@altos.com' } }] },
          event_data: [{ object: 'hardbounce', details: [{ bounced_recipient: 'admin@altos.com', reason: 'User unknown' }] }],
          request_id: 'req-1',
        },
      ],
      webhook_request_id: id,
    });

  it('the webhook is public, authenticated by its own header and signature, stored once and processed in the background', async () => {
    ctx = await startTestApp({ SEND_PAUSE_MS: '0' });
    const token = await signIn();
    const receipt = await sendOne(token);
    const attemptId = ctx.email.calls[0]?.attemptId as string;

    expect((await postWebhook(hardBounce(attemptId), undefined, { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await postWebhook(hardBounce(attemptId), ctx.clock.now().getTime() - 10 * 60_000)).statusCode).toBe(401);
    const unsigned = await ctx.app.inject({ method: 'POST', url: '/webhooks/zeptomail', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'data=%7B%7D' });
    expect(unsigned.statusCode).toBe(401);
    expect(await ctx.repository.webhooks.get('wr-1')).toBeUndefined();

    expect((await postWebhook(hardBounce(attemptId))).statusCode).toBe(200);
    expect((await postWebhook(hardBounce(attemptId))).statusCode).toBe(200);
    expect((await ctx.repository.webhooks.get('wr-1'))?.processedAt).toBeUndefined();
    await settle();

    expect(await ctx.repository.receipts.get(receipt?.sha256 as never)).toMatchObject({ deliveryState: 'HARD_BOUNCE' });
    const suppressions = (await call('GET', '/suppressions', token)).json();
    expect(suppressions).toMatchObject({ release: 'PROVIDER_API', addresses: [{ email: 'admin@altos.com', reason: 'HARD_BOUNCE' }] });
    expect((await call('GET', '/alerts', token)).json().map((a: { type: string }) => a.type)).toContain('HARD_BOUNCE');

    // D20: what was received can be queried only with the operator's token.
    expect((await ctx.app.inject({ method: 'GET', url: '/webhooks/zeptomail/events' })).statusCode).toBe(401);
    const events = (await call('GET', '/webhooks/zeptomail/events', token)).json();
    expect(events).toEqual([expect.objectContaining({ webhookRequestId: 'wr-1', provider: 'ZEPTOMAIL', events: [expect.objectContaining({ state: 'HARD_BOUNCE' })] })]);
    expect(events[0]).not.toHaveProperty('body');
    expect((await call('GET', '/webhooks/zeptomail/events/wr-1', token)).json()).toMatchObject({ webhookRequestId: 'wr-1', body: hardBounce(attemptId), processedAt: expect.any(String) });
    expect((await call('GET', '/webhooks/zeptomail/events/nope', token)).statusCode).toBe(404);
  });

  it('manual verification over HTTP (D22)', async () => {
    ctx = await startTestApp({ SEND_PAUSE_MS: '0' });
    const token = await signIn();
    const receipt = await sendOne(token);
    ctx.lookup.setResult(ctx.email.calls[0]?.attemptId as string, { kind: 'FOUND', status: 'DELIVERED' });
    expect((await ctx.app.inject({ method: 'POST', url: `/receipts/${receipt?.sha256}/verify-delivery` })).statusCode).toBe(401);
    expect((await call('POST', '/batches/2026-10/CASH/verify-delivery', token)).json()).toEqual({
      receipts: [expect.objectContaining({ sha256: receipt?.sha256, result: 'UPDATED', providerStatus: 'DELIVERED', state: 'SENT', deliveryState: 'ACCEPTED' })],
    });
    const again = await call('POST', `/receipts/${receipt?.sha256}/verify-delivery`, token);
    expect([again.statusCode, again.json()]).toEqual([409, { error: 'RECEIPT_NOT_VERIFIABLE' }]);
    expect((await call('POST', '/batches/2026-10/ANGLO/verify-delivery', token)).statusCode).toBe(404);
  });

  it('resend, release and manual resolution endpoints', async () => {
    ctx = await startTestApp({ SEND_PAUSE_MS: '0' });
    const token = await signIn();
    const receipt = await sendOne(token);
    const sha = receipt?.sha256 as string;
    expect((await call('POST', `/receipts/${sha}/resend`, token)).json()).toEqual({ error: 'RECEIPT_NOT_RESENDABLE' });
    expect((await call('POST', `/receipts/${sha}/resolve`, token, { outcome: 'SENT', note: 'x' })).statusCode).toBe(409);
    expect((await call('POST', `/receipts/${sha}/resolve`, token, { outcome: 'MAYBE', note: 'x' })).statusCode).toBe(400);

    await postWebhook(hardBounce(ctx.email.calls[0]?.attemptId as string));
    await settle();
    const resend = await call('POST', `/receipts/${sha}/resend`, token);
    expect([resend.statusCode, resend.json()]).toEqual([409, { error: 'FILE_NOT_AVAILABLE' }]);

    const release = (payload: object) => call('POST', '/suppressions/admin@altos.com/release', token, payload);
    expect((await release({ note: 'ok' })).json()).toEqual({ error: 'BUSINESS_CONFIRMATION_REQUIRED' });
    expect((await release({ note: 'ok', businessConfirmed: true })).json()).toEqual({ email: 'admin@altos.com', provider: 'NOT_SUPPRESSED' });
    expect((await release({ note: 'ok', businessConfirmed: true })).statusCode).toBe(404);
    expect((await call('POST', '/suppressions/admin@altos.com/release', 'bad-token', { note: 'x' })).statusCode).toBe(401);
  });

  it('end to end with the ZeptoMail simulator: signed webhooks, an uncertain send and a lost webhook, reconciled through the logs API', async () => {
    const holder: { ctx?: TestContext } = {};
    const zm = createZeptoMailMock({
      apiKey: 'agent-key',
      verifiedDomains: ['anutibara.com'],
      oauthToken: 'access-1',
      oauthClient: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
      timeoutMs: 300,
      now: () => holder.ctx?.clock.now() ?? new Date(),
    });
    mock = zm;
    await zm.listen({ port: 0, host: '127.0.0.1' });
    const origin = `http://127.0.0.1:${(zm.server.address() as AddressInfo).port}`;
    const tokens = new ZohoOAuthTokenProvider({ accountsUrl: origin, clientId: 'c', clientSecret: 's', refreshToken: 'r', timeoutMs: 1000 });
    ctx = await startTestApp(
      { SEND_PAUSE_MS: '0' },
      {
        adapters: {
          emailProvider: new ZeptoMailEmailProvider({ baseUrl: `${origin}/v1.1`, apiKey: 'agent-key', from: { address: 'soportes@anutibara.com' }, timeoutMs: 150 }),
          sendLookup: new ZeptoMailSendLookup({ baseUrl: `${origin}/v1.1`, timeoutMs: 1000 }, tokens),
        },
      },
    );
    holder.ctx = ctx;
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    zm.setWebhook({
      url: `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/webhooks/zeptomail`,
      authenticationKey: WEBHOOK_SECRETS.authenticationKey,
      authorization: { name: 'Authorization', value: WEBHOOK_SECRETS.authorizationValue },
    });
    const token = await signIn();

    // 1. Sent and delivered, but the delivery webhook is lost.
    const delivered = await sendOne(token, 'ok');
    expect(delivered?.state).toBe('SENT');
    await zm.emit(zm.accepted[0]?.clientReference as string, 'delivered', { webhook: false });

    // 2. The response is lost (timeout) although the email went out: UNCERTAIN, found by the 5-minute lookup.
    ctx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'admin+zm-timeout@altos.com' });
    const slow = await sendOne(token, 'slow');
    expect(slow?.state).toBe('UNCERTAIN');
    await new Promise((resolve) => setTimeout(resolve, 400));
    ctx.clock.advance(6 * 60_000);
    await settle();
    expect(await ctx.repository.receipts.get(slow?.sha256 as never)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED' });

    // 3. A signed webhook from the simulator reaches the real endpoint and moves it on.
    const posted = await zm.emit(zm.accepted[1]?.clientReference as string, 'softbounce');
    expect(posted?.response).toBe(200);
    await settle();
    expect(await ctx.repository.receipts.get(slow?.sha256 as never)).toMatchObject({ deliveryState: 'SOFT_BOUNCE' });

    // 4. Seven hours later the sweep finds the first one delivered in the logs and raises WEBHOOKS_NOT_RECEIVED once.
    ctx.clock.advance(7 * HOUR);
    await ctx.adapters.jobQueue.enqueue({ type: 'SWEEP_UNCONFIRMED', payload: {} });
    await settle();
    expect(await ctx.repository.receipts.get(delivered?.sha256 as never)).toMatchObject({ state: 'SENT', deliveryState: 'ACCEPTED' });
    const alerts = (await ctx.repository.alerts.list()).filter((a) => a.type === 'WEBHOOKS_NOT_RECEIVED');
    expect(alerts).toHaveLength(1);
    expect(zm.tokensIssued()).toBe(1);
  });
});
