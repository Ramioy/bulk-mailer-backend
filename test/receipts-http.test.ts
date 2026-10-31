import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '../src/adapters/outbound/pdf/basic-pdf-inspector';
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
    expect(refreshed.json()).toEqual({ manifestVersion: 3, refreshed: 1 });
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
