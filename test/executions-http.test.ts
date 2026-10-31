import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileName, pdfBytes } from './support/receipt-fixtures';
import { startTestApp, TEST_PASSWORD, type TestContext } from './support/test-app';

const BOUNDARY = 'b0undary';
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

/** Parses an SSE body into `{ id, event, data }` records. */
function parseSse(body: string) {
  return body
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => {
      const field = (name: string) => block.split('\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
      return { id: field('id'), event: field('event'), data: JSON.parse(field('data') ?? '{}') };
    });
}

describe('executions over HTTP', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startTestApp({ SEND_PAUSE_MS: '0' });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const signIn = async () =>
    (await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username: 'operador', password: TEST_PASSWORD } })).json();
  const get = (url: string, token: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...headers } });

  async function uploadAndSend(token: string, count = 2) {
    const files = Array.from({ length: count }, (_, i) => ({ name: fileName(`Torre ${i}`, 'MULTA', '104522'), content: pdfBytes(`t${i}`) }));
    await ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/receipts',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart(files),
    });
    const version = (await get('/batches/2026-10/CASH', token)).json().manifestVersion;
    return ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/executions',
      headers: { authorization: `Bearer ${token}` },
      payload: { manifestVersion: version },
    });
  }

  it('answers 202 and runs in the background, even after the operator signs out (D9); a new session sees the result (D10)', async () => {
    const session = await signIn();
    const started = await uploadAndSend(session.accessToken);
    expect(started.statusCode).toBe(202);
    const { executionId } = started.json();

    const running = (await get('/executions/current', session.accessToken)).json();
    expect(running).toMatchObject({ executionId, batchState: 'RUNNING', counters: { processed: 0 } });

    await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', payload: { refreshToken: session.refreshToken } });
    expect((await get('/executions/current', session.accessToken)).statusCode).toBe(401);

    await ctx.runner.drain();
    expect(ctx.email.calls).toHaveLength(2);

    const again = await signIn();
    const status = (await get('/executions/current', again.accessToken)).json();
    expect(status).toMatchObject({
      executionId,
      result: 'COMPLETED',
      batchState: 'COMPLETED',
      startedBy: 'operador',
      counters: { total: 2, processed: 2, byState: { SENT: 2 } },
    });
    expect(status.lastEventSeq).toBe(4);
  });

  it('refuses a stale manifest version with 409 and the differences', async () => {
    const { accessToken } = await signIn();
    await uploadAndSend(accessToken, 1);
    await ctx.runner.drain();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/executions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { manifestVersion: 99 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'BATCH_NOT_EXECUTABLE' });

    await ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/receipts',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart([{ name: fileName('Nueva', 'MULTA', '104522'), content: pdfBytes('nueva') }]),
    });
    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/executions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { manifestVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    // The receipt sent by the previous execution is no longer ready: it shows as REMOVED next to the new one.
    expect(stale.json()).toMatchObject({ error: 'MANIFEST_CHANGED', currentVersion: 2 });
    expect(stale.json().differences.map((d: { type: string; fileName: string }) => [d.type, d.fileName])).toEqual([
      ['ADDED', fileName('Nueva', 'MULTA', '104522')],
      ['REMOVED', fileName('Torre 0', 'MULTA', '104522')],
    ]);
  });

  it('replays the stored events and resumes after Last-Event-ID (D11)', async () => {
    const { accessToken } = await signIn();
    const { executionId } = (await uploadAndSend(accessToken)).json();
    await ctx.runner.drain();

    const all = parseSse((await get(`/executions/${executionId}/events`, accessToken)).body);
    expect(all.map((e) => [e.id, e.event])).toEqual([
      ['1', 'STARTED'],
      ['2', 'RECEIPT_PROCESSED'],
      ['3', 'RECEIPT_PROCESSED'],
      ['4', 'FINISHED'],
    ]);
    const resumed = parseSse((await get(`/executions/${executionId}/events`, accessToken, { 'last-event-id': '2' })).body);
    expect(resumed.map((e) => e.id)).toEqual(['3', '4']);
    expect(resumed[1]?.data).toMatchObject({ batchState: 'COMPLETED', counters: { processed: 2 } });
  });

  it('streams live events and closes when the access token expires (D12)', async () => {
    await ctx.app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
    const { accessToken } = await signIn();
    const { executionId } = (await uploadAndSend(accessToken)).json();

    // The token has ~300 ms left when the stream opens.
    ctx.clock.advance(15 * 60_000 - 300);
    const response = await fetch(`${base}/executions/${executionId}/events`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reading = response.text();
    await ctx.runner.drain();
    const events = parseSse(await reading);
    // Live events arrive; the stream ends with FINISHED (or TOKEN_EXPIRED if the execution were still running).
    expect(events.map((e) => e.event)).toEqual(['STARTED', 'RECEIPT_PROCESSED', 'RECEIPT_PROCESSED', 'FINISHED']);
  });

  it('closes a stream of a still-running execution when the token expires', async () => {
    await ctx.app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
    const { accessToken } = await signIn();
    const { executionId } = (await uploadAndSend(accessToken)).json();
    ctx.clock.advance(15 * 60_000 - 200);

    const started = Date.now();
    const body = await (await fetch(`${base}/executions/${executionId}/events`, { headers: { authorization: `Bearer ${accessToken}` } })).text();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(parseSse(body).map((e) => e.event)).toEqual(['TOKEN_EXPIRED']);
  });

  it('lists alerts', async () => {
    const { accessToken } = await signIn();
    ctx.email.respondWith({ kind: 'ACCOUNT_ERROR', detail: 'LE_102' });
    await uploadAndSend(accessToken, 1);
    await ctx.runner.drain();
    expect((await get('/alerts', accessToken)).json()).toMatchObject([{ type: 'BATCH_STOPPED', detail: '2026-10/CASH stopped: PROVIDER_ACCOUNT' }]);
  });
});
