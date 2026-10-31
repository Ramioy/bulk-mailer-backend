import { createServer, type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { RedirectingEmailProvider } from '../../src/adapters/outbound/zeptomail/redirecting-email-provider';
import { ZeptoMailEmailProvider } from '../../src/adapters/outbound/zeptomail/zeptomail-email-provider';
import type { OutgoingEmail } from '../../src/ports/email-provider';
import { createZeptoMailMock } from '../../mocks/zeptomail-api';
import { pdfBytes } from '../support/receipt-fixtures';

const email = (overrides: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  attemptId: 'attempt-1',
  to: 'admin@altos.com',
  subject: 'Multa – Octubre 2026',
  textBody: 'Señores Edificio Altos:',
  attachment: { name: 'Edificio Altos CNCPT MULTA CNTRT 104522.pdf', content: pdfBytes('z') },
  ...overrides,
});
const forced = (scenario: string) => email({ to: `admin+zm-${scenario}@altos.com` });

for (const errorFormat of ['details', 'documented'] as const) {
  describe(`ZeptoMailEmailProvider against the simulated API (error format: ${errorFormat})`, () => {
    const mock = createZeptoMailMock({ apiKey: 'agent-key', verifiedDomains: ['anutibara.com'], errorFormat, timeoutMs: 1_000 });
    let baseUrl: string;
    let provider: ZeptoMailEmailProvider;
    const make = (overrides: Partial<ConstructorParameters<typeof ZeptoMailEmailProvider>[0]> = {}) =>
      new ZeptoMailEmailProvider({ baseUrl, apiKey: 'agent-key', from: { address: 'soportes@anutibara.com', name: 'Anutibara' }, timeoutMs: 500, ...overrides });

    beforeAll(async () => {
      await mock.listen({ port: 0, host: '127.0.0.1' });
      baseUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}/v1.1`;
      provider = make();
    });

    afterAll(async () => {
      await mock.close();
    });

    it('sends the documented request and maps EM_104 to ACCEPTED with the request_id', async () => {
      const outcome = await provider.send(email({ copyTo: 'archivo@anutibara.com' }));
      const sent = mock.accepted.at(-1);
      expect(outcome).toEqual({ kind: 'ACCEPTED', providerRequestId: sent?.requestId });
      expect(sent).toMatchObject({
        clientReference: 'attempt-1',
        from: 'soportes@anutibara.com',
        to: ['admin@altos.com'],
        bcc: ['archivo@anutibara.com'],
        subject: 'Multa – Octubre 2026',
        textbody: 'Señores Edificio Altos:',
        attachments: [{ name: 'Edificio Altos CNCPT MULTA CNTRT 104522.pdf', mimeType: 'application/pdf', bytes: pdfBytes('z').length }],
      });
    });

    it.each(['LE_101', 'LE_102', 'SERR_156', 'SERR_157', 'SM_111', 'SM_128', 'SM_133', 'SMI_115', 'AE_101'])(
      'maps account or configuration code %s to ACCOUNT_ERROR (the batch stops)',
      async (code) => {
        expect(await provider.send(forced(code))).toMatchObject({ kind: 'ACCOUNT_ERROR', detail: expect.stringContaining(code) });
      },
    );

    it('maps a wrong API key (HTTP 401) to ACCOUNT_ERROR', async () => {
      expect(await make({ apiKey: 'wrong' }).send(email())).toMatchObject({ kind: 'ACCOUNT_ERROR', detail: expect.stringContaining('401') });
    });

    it('maps an unverified sender domain to ACCOUNT_ERROR', async () => {
      expect(await make({ from: { address: 'x@otro.com' } }).send(email())).toMatchObject({ kind: 'ACCOUNT_ERROR' });
    });

    it('maps an invalid recipient to RECEIPT_REJECTED (the batch continues)', async () => {
      const outcome = await provider.send(email({ to: 'no-es-correo' }));
      expect(outcome.kind).toBe('RECEIPT_REJECTED');
    });

    it('maps attachment problems to RECEIPT_REJECTED', async () => {
      const notPdf = email({ attachment: { name: 'a.pdf', content: new Uint8Array(Buffer.from('PK zip')) } });
      expect(await provider.send(notPdf)).toMatchObject({ kind: 'RECEIPT_REJECTED', detail: expect.stringContaining('SM_120') });
    });

    it('maps a missing subject (our request) to REQUEST_ERROR', async () => {
      expect(await provider.send(email({ subject: ' ' }))).toMatchObject({ kind: 'REQUEST_ERROR', detail: expect.stringContaining('GE_102') });
    });

    it.each([
      ['429', { kind: 'UNCERTAIN', detail: 'HTTP 429', retryAfterSeconds: 30 }],
      ['503', { kind: 'UNCERTAIN', detail: 'HTTP 503' }],
      ['500', { kind: 'UNCERTAIN', detail: 'HTTP 500' }],
    ])('maps %s to UNCERTAIN', async (scenario, expected) => {
      expect(await provider.send(forced(scenario))).toMatchObject(expected);
    });

    it('maps an undocumented 200 body, a timeout and a reset connection to UNCERTAIN', async () => {
      expect(await provider.send(forced('empty200'))).toMatchObject({ kind: 'UNCERTAIN', detail: expect.stringContaining('without EM_104') });
      expect(await provider.send(forced('timeout'))).toEqual({ kind: 'UNCERTAIN', detail: 'timeout after 500 ms' });
      expect(await provider.send(forced('reset'))).toMatchObject({ kind: 'UNCERTAIN' });
    });
  });
}

describe('ZeptoMailEmailProvider without a server', () => {
  it('maps a refused connection (nothing left) to CONNECTION_FAILED', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    const provider = new ZeptoMailEmailProvider({ baseUrl: `http://127.0.0.1:${port}/v1.1`, apiKey: 'k', from: { address: 'a@anutibara.com' }, timeoutMs: 500 });
    expect(await provider.send(email())).toEqual({ kind: 'CONNECTION_FAILED', detail: 'ECONNREFUSED' });
  });

  it('distinguishes SM_113 on the archive copy (configuration) from SM_113 on the recipient', async () => {
    const answer = (target: string) =>
      new ZeptoMailEmailProvider({
        baseUrl: 'http://x',
        apiKey: 'k',
        from: { address: 'a@anutibara.com' },
        timeoutMs: 500,
        fetch: async () => new Response(JSON.stringify({ error: { code: 'TM_4001', details: [{ code: 'SM_113', target }] } }), { status: 400 }),
      });
    expect((await answer('bcc').send(email())).kind).toBe('ACCOUNT_ERROR');
    expect((await answer('to').send(email())).kind).toBe('RECEIPT_REJECTED');
  });

  it('treats an unknown 400 code as UNCERTAIN (undocumented)', async () => {
    const provider = new ZeptoMailEmailProvider({
      baseUrl: 'http://x',
      apiKey: 'k',
      from: { address: 'a@anutibara.com' },
      timeoutMs: 500,
      fetch: async () => new Response(JSON.stringify({ data: { error_code: 'TM_3004', message: 'Invalid request' }, message: 'error' }), { status: 400 }),
    });
    expect(await provider.send(email())).toMatchObject({ kind: 'UNCERTAIN', detail: expect.stringContaining('TM_3004') });
  });
});

describe('RedirectingEmailProvider (non-production)', () => {
  it('sends everything to the test mailbox and shows the intended recipient in the subject', async () => {
    const inner = new FakeEmailProvider();
    await new RedirectingEmailProvider(inner, 'pruebas@anutibara.com').send(email({ copyTo: 'archivo@anutibara.com' }));
    expect(inner.calls[0]).toMatchObject({ to: 'pruebas@anutibara.com', copyTo: 'pruebas@anutibara.com', subject: '[PRUEBA → admin@altos.com] Multa – Octubre 2026' });
  });
});
