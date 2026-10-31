import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '../src/adapters/outbound/pdf/basic-pdf-inspector';
import { OCT_2026 } from './support/builders';
import { fileName, pdfBytes } from './support/receipt-fixtures';
import { startTestApp, TEST_PASSWORD, type TestContext } from './support/test-app';

const BOUNDARY = 'bulkmailerboundary';

/** Raw multipart body, as a browser sends it: file names in UTF-8. */
function multipart(files: Array<{ name: string; content: Uint8Array }>): Buffer {
  const parts = files.flatMap(({ name, content }) => [
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'),
    Buffer.from(content),
    Buffer.from('\r\n'),
  ]);
  return Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

describe('receipts over HTTP', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await startTestApp();
    const signIn = await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username: 'operador', password: TEST_PASSWORD } });
    token = signIn.json().accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });
  const upload = (url: string, files: Array<{ name: string; content: Uint8Array }>) =>
    ctx.app.inject({
      method: 'POST',
      url,
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart(files),
    });

  it('requires authentication', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/batches/2026-10/CASH' })).statusCode).toBe(401);
  });

  it('uploads files with accented names and returns the result per file', async () => {
    const response = await upload('/batches/2026-10/CASH/receipts', [
      { name: fileName('Edificio Altos Ñuñoa', 'PAGO ADMINISTRACIÓN', '104522'), content: pdfBytes('h1') },
      { name: 'sin formato.pdf', content: pdfBytes('h2') },
    ]);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.manifestVersion).toBe(1);
    expect(body.results.map((r: { fileName: string; state: string; errorType?: string }) => [r.fileName, r.state, r.errorType])).toEqual([
      ['Edificio Altos Ñuñoa CNCPT PAGO ADMINISTRACIÓN CNTRT 104522.pdf', 'PENDING', undefined],
      ['sin formato.pdf', 'INVALID', 'INVALID_NAME'],
    ]);
  });

  it('D31: same content under two names blocks it; the operator resolves it with POST /receipts/{sha256}/resolve-conflict', async () => {
    const content = pdfBytes('same');
    const first = fileName('Edificio Altos', 'MULTA', '104522');
    const second = fileName('Otro conjunto', 'MULTA', '104522');
    const uploaded = (await upload('/batches/2026-09/CASH/receipts', [{ name: first, content }, { name: second, content }])).json();
    expect(uploaded.results.map((r: { outcome: string }) => r.outcome)).toEqual(['REGISTERED', 'DUPLICATE_CONFLICT']);
    const sha256 = uploaded.results[0].sha256 as string;
    const url = `/receipts/${sha256}/resolve-conflict`;

    expect((await ctx.app.inject({ method: 'POST', url, headers: auth(), payload: { fileName: second } })).json()).toEqual({ error: 'INVALID_REQUEST', field: 'note' });
    const wrong = await ctx.app.inject({ method: 'POST', url, headers: auth(), payload: { fileName: 'x.pdf', note: 'n' } });
    expect([wrong.statusCode, wrong.json()]).toEqual([422, { error: 'NAME_NOT_IN_CONFLICT' }]);
    const ok = await ctx.app.inject({ method: 'POST', url, headers: auth(), payload: { fileName: second, note: 'Confirmado por el negocio' } });
    expect([ok.statusCode, ok.json()]).toMatchObject([200, { fileName: second, block: 'CASH', state: 'PENDING', email: 'admin@altos.com' }]);
    const again = await ctx.app.inject({ method: 'POST', url, headers: auth(), payload: { fileName: second, note: 'n' } });
    expect([again.statusCode, again.json()]).toEqual([409, { error: 'RECEIPT_NOT_IN_CONFLICT' }]);
  });

  it('flags a file above 15 MB without reading it whole', async () => {
    const response = await upload('/batches/2026-10/CASH/receipts', [
      { name: fileName('Grande', 'MULTA', '104522'), content: new Uint8Array(MAX_ATTACHMENT_BYTES + 10) },
    ]);
    expect(response.json().results[0]).toMatchObject({ outcome: 'REJECTED', errorType: 'ATTACHMENT_TOO_LARGE' });
  });

  it('returns the batch summary for review', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/batches/2026-10/CASH', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      period: '2026-10',
      block: 'CASH',
      state: 'OPEN',
      manifestVersion: 1,
      readyToSend: [{ complexName: 'Edificio Altos', email: 'admin@altos.com', conceptKey: 'PAGO ADMINISTRACIÓN' }],
      needsCorrection: [{ fileName: 'sin formato.pdf', errorType: 'INVALID_NAME' }],
    });
  });

  it('removes a receipt and refreshes recipients', async () => {
    const summary = (await ctx.app.inject({ method: 'GET', url: '/batches/2026-10/CASH', headers: auth() })).json();
    const sha256 = summary.needsCorrection[0].sha256;
    const removed = await ctx.app.inject({ method: 'DELETE', url: `/receipts/${sha256}`, headers: auth() });
    expect([removed.statusCode, removed.json()]).toEqual([200, { manifestVersion: 2 }]);
    const again = await ctx.app.inject({ method: 'DELETE', url: `/receipts/${sha256}`, headers: auth() });
    expect([again.statusCode, again.json().error]).toEqual([409, 'RECEIPT_NOT_REMOVABLE']);

    const refreshed = await ctx.app.inject({ method: 'POST', url: '/batches/2026-10/CASH/refresh-recipients', headers: auth() });
    expect(refreshed.json()).toEqual({ manifestVersion: 3, refreshed: 1, withoutFile: 0 });
  });

  it('D51: releases the files of a batch with POST /batches/{period}/{block}/release-files, with a note', async () => {
    const before = (await ctx.app.inject({ method: 'GET', url: '/batches/2026-10/CASH', headers: auth() })).json();
    const release = (url: string, payload: object) => ctx.app.inject({ method: 'POST', url, headers: auth(), payload });
    const withoutNote = await release('/batches/2026-10/CASH/release-files', {});
    expect([withoutNote.statusCode, withoutNote.json()]).toEqual([400, { error: 'INVALID_REQUEST', field: 'note' }]);
    const blankNote = await release('/batches/2026-10/CASH/release-files', { note: '  ' });
    expect([blankNote.statusCode, blankNote.json().error]).toEqual([400, 'NOTE_REQUIRED']);
    const unknown = await release('/batches/2026-09/ANGLO/release-files', { note: 'cleanup' });
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, 'BATCH_NOT_FOUND']);

    const released = await release('/batches/2026-10/CASH/release-files', { note: 'retention: kept since October' });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ released: expect.any(Number), manifestVersion: before.manifestVersion + 1 });
    expect(released.json().released).toBeGreaterThan(0);
    const after = (await ctx.app.inject({ method: 'GET', url: '/batches/2026-10/CASH', headers: auth() })).json();
    expect(after.readyToSend).toEqual([]);
  });

  it.each([
    ['/batches/2026-13/CASH', 400, 'INVALID_PERIOD'],
    ['/batches/2026-10/EFECTIVO', 400, 'INVALID_BLOCK'],
  ])('validates parameters: %s', async (url, status, error) => {
    const response = await ctx.app.inject({ method: 'GET', url, headers: auth() });
    expect([response.statusCode, response.json().error]).toEqual([status, error]);
  });

  it('refuses periods that cannot be operated (422) and non-multipart uploads (400)', async () => {
    const old = await upload('/batches/2026-01/CASH/receipts', [{ name: fileName('A', 'MULTA', '104522'), content: pdfBytes('old') }]);
    expect([old.statusCode, old.json().error]).toEqual([422, 'PERIOD_NOT_OPERABLE']);
    const json = await ctx.app.inject({ method: 'POST', url: '/batches/2026-10/CASH/receipts', headers: auth(), payload: {} });
    expect([json.statusCode, json.json().error]).toEqual([400, 'EXPECTED_MULTIPART']);
  });
});

describe('uploads streamed to the staging area (D48)', () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.app.close();
  });

  async function start(env: Record<string, string> = {}) {
    ctx = await startTestApp(env);
    const token = (await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username: 'operador', password: TEST_PASSWORD } })).json().accessToken;
    return (files: Array<{ name: string; content: Uint8Array }>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/batches/2026-10/CASH/receipts',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload: multipart(files),
      });
  }

  it('stages each part while receiving it, reads one file at a time for the inspector and moves the kept ones into place', async () => {
    const upload = await start();
    const store = ctx.adapters.fileStore;
    const staged = vi.spyOn(store, 'stage');
    const saved = vi.spyOn(store, 'save');
    let reading = 0;
    let maxReading = 0;
    const readStaged = store.readStaged.bind(store);
    vi.spyOn(store, 'readStaged').mockImplementation(async (file) => {
      reading += 1;
      maxReading = Math.max(maxReading, reading);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return await readStaged(file);
      } finally {
        reading -= 1;
      }
    });
    const response = await upload([
      { name: fileName('Uno', 'MULTA', '104522'), content: pdfBytes('uno') },
      { name: fileName('Dos', 'MULTA', '104522'), content: pdfBytes('dos') },
      { name: 'sin formato.pdf', content: pdfBytes('tres') },
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((r: { state: string }) => r.state)).toEqual(['PENDING', 'PENDING', 'INVALID']);
    expect(staged).toHaveBeenCalledTimes(3);
    // No file's bytes are written from memory: the two kept ones were renamed into place, the invalid one dropped.
    expect(saved).not.toHaveBeenCalled();
    expect(maxReading).toBe(1);
    expect(await store.listStaged()).toEqual([]);
    expect(await store.list()).toHaveLength(2);
  });

  it('answers 413 UPLOAD_TOO_LARGE over the total budget, registers nothing and leaves nothing staged', async () => {
    const upload = await start({ UPLOAD_MAX_TOTAL_BYTES: '150' });
    const response = await upload([
      { name: fileName('Uno', 'MULTA', '104522'), content: pdfBytes('uno') },
      { name: fileName('Dos', 'MULTA', '104522'), content: pdfBytes('dos') },
      { name: fileName('Tres', 'MULTA', '104522'), content: pdfBytes('tres') },
    ]);
    expect([response.statusCode, response.json()]).toEqual([413, { error: 'UPLOAD_TOO_LARGE', maxTotalBytes: 150, maxFiles: 300 }]);
    expect(response.headers.connection).toBe('close');
    expect(await ctx.repository.receipts.listByBatch(OCT_2026, 'CASH')).toEqual([]);
    expect(await ctx.adapters.fileStore.listStaged()).toEqual([]);
  });

  it('answers 413 over UPLOAD_MAX_FILES', async () => {
    const upload = await start({ UPLOAD_MAX_FILES: '2' });
    const response = await upload([
      { name: fileName('Uno', 'MULTA', '104522'), content: pdfBytes('uno') },
      { name: fileName('Dos', 'MULTA', '104522'), content: pdfBytes('dos') },
      { name: fileName('Tres', 'MULTA', '104522'), content: pdfBytes('tres') },
    ]);
    expect([response.statusCode, response.json().error]).toEqual([413, 'UPLOAD_TOO_LARGE']);
    expect(await ctx.repository.receipts.listByBatch(OCT_2026, 'CASH')).toEqual([]);
    expect(await ctx.adapters.fileStore.listStaged()).toEqual([]);
  });
});
