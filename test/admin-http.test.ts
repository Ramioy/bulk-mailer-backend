import { afterEach, describe, expect, it } from 'vitest';

import { OCT_2026 } from './support/builders';
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

describe('administration over HTTP (§13)', () => {
  let ctx: TestContext;
  let token: string;

  afterEach(() => ctx.app.close());

  async function start(env: Record<string, string> = {}) {
    ctx = await startTestApp(env);
    token = (await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username: 'operador', password: TEST_PASSWORD } })).json().accessToken;
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const upload = (seed: string, concept: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/batches/2026-10/CASH/receipts',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart([{ name: fileName(`Torre ${seed}`, concept, '104522'), content: pdfBytes(seed) }]),
    });
  async function sendBatch() {
    const version = (await call('GET', '/batches/2026-10/CASH')).json().manifestVersion;
    expect((await call('POST', '/batches/2026-10/CASH/executions', { manifestVersion: version })).statusCode).toBe(202);
    for (let round = 0; round < 3; round += 1) {
      await ctx.relay.drain();
      await ctx.runner.drain();
    }
  }

  it('adds a concept that later uploads accept; retiring it rejects later uploads but keeps what was loaded', async () => {
    await start();
    const added = await call('POST', '/concepts', { key: 'SANCIÓN', subject: 'Sanción' });
    expect([added.statusCode, added.json()]).toEqual([201, { key: 'SANCIÓN', subject: 'Sanción', active: true }]);
    expect((await call('POST', '/concepts', { key: 'SANCIÓN', subject: 'Otra' })).json()).toEqual({ error: 'CONCEPT_ALREADY_EXISTS' });
    expect((await call('POST', '/concepts', { key: 'A CNTRT', subject: 'x' })).json()).toEqual({ error: 'INVALID_CONCEPT_KEY', reason: 'RESERVED_WORD' });
    expect((await call('POST', '/concepts', { key: 'X' })).statusCode).toBe(400);

    expect((await upload('a', 'SANCIÓN')).json().results[0]).toMatchObject({ state: 'PENDING' });

    const retired = await call('PATCH', `/concepts/${encodeURIComponent('SANCIÓN')}`, { active: false });
    expect([retired.statusCode, retired.json().active]).toEqual([200, false]);
    expect((await upload('b', 'SANCIÓN')).json().results[0]).toMatchObject({ state: 'INVALID', errorType: 'UNKNOWN_CONCEPT' });
    expect((await ctx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => [r.fileName.slice(0, 7), r.state]).sort()).toEqual([
      ['Torre a', 'PENDING'],
      ['Torre b', 'INVALID'],
    ]);

    const concepts = (await call('GET', '/concepts')).json().concepts;
    expect(concepts).toContainEqual({ key: 'SANCIÓN', subject: 'Sanción', active: false });
    expect(concepts).toHaveLength(4);
    expect((await ctx.repository.audit.list()).filter((a) => a.action === 'CONCEPT_CHANGED').map((a) => [a.actor, a.subject])).toEqual([
      ['operador', 'SANCIÓN'],
      ['operador', 'SANCIÓN'],
    ]);
  });

  it('a new subject applies to the next send', async () => {
    await start();
    expect((await call('PATCH', '/concepts/MULTA', { subject: 'Multa por ruido' })).json()).toEqual({ key: 'MULTA', subject: 'Multa por ruido', active: true });
    await upload('a', 'MULTA');
    await sendBatch();
    expect(ctx.email.calls.map((c) => c.subject)).toEqual([expect.stringContaining('Multa por ruido')]);
  });

  it('validates the concept changes', async () => {
    await start();
    expect((await call('PATCH', '/concepts/NO%20EXISTE', { active: false })).statusCode).toBe(404);
    expect((await call('PATCH', '/concepts/MULTA', {})).json()).toEqual({ error: 'NOTHING_TO_CHANGE' });
    expect((await call('PATCH', '/concepts/MULTA', { active: 'no' })).json()).toEqual({ error: 'INVALID_REQUEST', field: 'active' });
    expect((await call('PATCH', '/concepts/MULTA', { subject: ' ' })).statusCode).toBe(422);
  });

  it('refuses to enable the archive copy without an address', async () => {
    await start();
    expect((await call('GET', '/settings/archive-copy')).json()).toEqual({ enabled: false, address: null });
    const response = await call('PUT', '/settings/archive-copy', { enabled: true });
    expect([response.statusCode, response.json()]).toEqual([409, { error: 'ARCHIVE_COPY_NOT_CONFIGURED' }]);
    expect((await call('PUT', '/settings/archive-copy', {})).statusCode).toBe(400);
  });

  it('enables the archive copy, audited, and the next execution sends it', async () => {
    await start({ ARCHIVE_COPY_ADDRESS: 'archivo@empresa.co' });
    expect((await call('PUT', '/settings/archive-copy', { enabled: true })).json()).toEqual({ enabled: true, address: 'archivo@empresa.co' });
    expect((await call('GET', '/settings/archive-copy')).json()).toEqual({ enabled: true, address: 'archivo@empresa.co' });
    expect((await ctx.repository.audit.list()).filter((a) => a.action === 'ARCHIVE_COPY_CHANGED')).toMatchObject([{ actor: 'operador', previousValue: 'false', newValue: 'true' }]);
    await upload('a', 'MULTA');
    await sendBatch();
    expect(ctx.email.calls.map((c) => c.copyTo)).toEqual(['archivo@empresa.co']);
  });

  it('D39: lists dead outbox events and retries one (JWT), audited', async () => {
    await start();
    // A poisoned consumer of RECEIPTS_UPLOADED.
    let down = true;
    (ctx.adapters.eventBus as { subscribe(type: string, c: () => Promise<void>): void }).subscribe('RECEIPTS_UPLOADED', async () => {
      if (down) throw new Error('consumer down');
    });
    await upload('a', 'MULTA');
    for (let i = 0; i < 10; i += 1) await ctx.relay.drain();

    expect((await ctx.app.inject({ method: 'GET', url: '/outbox/dead' })).statusCode).toBe(401);
    const listed = await call('GET', '/outbox/dead?limit=5');
    expect(listed.statusCode).toBe(200);
    const [dead] = listed.json().events;
    expect(dead).toMatchObject({ type: 'RECEIPTS_UPLOADED', attempts: 10, lastError: 'Error: consumer down' });
    expect((await call('GET', '/outbox/dead?limit=0')).statusCode).toBe(400);
    expect((await call('GET', '/alerts')).json().map((a: { type: string }) => a.type)).toContain('OUTBOX_EVENT_DEAD');

    expect((await ctx.app.inject({ method: 'POST', url: `/outbox/dead/${dead.eventId}/retry` })).statusCode).toBe(401);
    const unknown = await call('POST', '/outbox/dead/nope/retry');
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'OUTBOX_EVENT_NOT_DEAD' }]);
    expect((await call('POST', `/outbox/dead/${dead.eventId}/retry`, { note: 7 } as object)).statusCode).toBe(400);
    down = false;
    const retried = await call('POST', `/outbox/dead/${dead.eventId}/retry`, { note: 'consumer fixed' });
    expect([retried.statusCode, retried.json()]).toEqual([200, { eventId: dead.eventId }]);
    expect((await ctx.repository.audit.list()).at(-1)).toMatchObject({ action: 'OUTBOX_EVENT_RETRIED', subject: dead.eventId, note: 'consumer fixed' });
    await ctx.relay.drain();
    expect((await call('GET', '/outbox/dead')).json().events).toEqual([]);
  });
});
