/**
 * Simulated Zoho ZeptoMail send API, following https://www.zoho.com/cpaas/help/api/email-sending.html
 * and the error-code table of https://www.zoho.com/cpaas/help/api/email-api-error-codes.html (read 2026-10-31).
 *
 *   POST /v1.1/email   Authorization: Zoho-enczapikey <key>   Content-Type: application/json
 *   200 → { "data": [{ "code": "EM_104", "additional_info": [...], "message": "OK" }], "message": "OK", "request_id": "…" }
 *   401 → wrong or missing Authorization (documented, body not documented)
 *   400 → validation and account errors with a sub-code (GE_102, SM_101, SM_111, SM_113, SM_120, SM_127, SM_129…)
 *
 * The error body format is NOT fully documented: the page shows `{ "data": { "error_code", "message" }, "message": "error" }`,
 * while ZeptoMail is known to answer `{ "error": { "code", "details": [{ "code", "message", "target", "target_value" }], … } }`.
 * Both are produced here (`errorFormat`) so the adapter is tested against both; confirm with the real account (§12.7).
 *
 * Forced scenarios: put `+zm-<scenario>` in the recipient's local part, e.g. `admin+zm-LE_102@altos.com`:
 *   timeout · reset · 429 · 500 · 503 · empty200 · LE_101 · LE_102 · SERR_156 · SERR_157 · SM_111 · SM_128 · SM_133 · SMI_115 · AE_101 · SM_113
 *
 * Run: node mocks/zeptomail-api.ts  (PORT, MOCK_API_KEY, MOCK_VERIFIED_DOMAINS=anutibara.com)
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

export interface ZeptoMailMockOptions {
  readonly apiKey: string;
  readonly verifiedDomains: readonly string[];
  readonly errorFormat?: 'details' | 'documented';
  /** Delay of the `timeout` scenario; default 60 s. */
  readonly timeoutMs?: number;
  /** Retry-After (seconds) of the `429` scenario; default 30. */
  readonly retryAfterSeconds?: number;
}

export interface AcceptedEmail {
  readonly requestId: string;
  readonly clientReference?: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly textbody?: string;
  readonly attachments: ReadonlyArray<{ readonly name: string; readonly mimeType: string; readonly bytes: number }>;
  readonly acceptedAt: Date;
}

const TOP_LEVEL: Readonly<Record<string, string>> = {
  GE_102: 'TM_3201',
  SM_101: 'TM_3301',
  SM_120: 'TM_3301',
  LE_101: 'TM_3501',
  SERR_156: 'TM_3601',
  SM_133: 'TM_3601',
  SMI_115: 'TM_3601',
  AE_101: 'TM_3601',
  SM_111: 'TM_4001',
  SM_113: 'TM_4001',
  SM_128: 'TM_4001',
  SERR_157: 'TM_4001',
  LE_102: 'TM_5001',
  SM_127: 'TM_8001',
  SM_129: 'TM_8001',
};

const MESSAGES: Readonly<Record<string, string>> = {
  GE_102: 'Mandatory field is missing or empty',
  SM_101: 'Invalid JSON',
  SM_120: 'Invalid Mimetype found',
  LE_101: 'Credits expired',
  SERR_156: 'Email sending IP is not in the allowed IPs list',
  SM_133: 'Trial mail sending limit exceeded',
  SMI_115: 'Per day limit exhausted, try after some time',
  AE_101: 'Account blocked',
  SM_111: 'Sender address domain is not verified in your Agent',
  SM_113: 'Invalid value',
  SM_128: 'Your CPaaS account is yet to be reviewed and approved',
  SERR_157: 'API key is invalid',
  LE_102: 'Credit exhausted',
  SM_127: 'Limit exceeded',
  SM_129: 'Length or size limit exceeded',
};

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

interface Address {
  readonly address?: unknown;
}

interface SendBody {
  readonly from?: Address;
  readonly to?: ReadonlyArray<{ readonly email_address?: Address }>;
  readonly bcc?: ReadonlyArray<{ readonly email_address?: Address }>;
  readonly subject?: unknown;
  readonly textbody?: unknown;
  readonly client_reference?: unknown;
  readonly attachments?: ReadonlyArray<{ readonly name?: unknown; readonly mime_type?: unknown; readonly content?: unknown }>;
}

export function createZeptoMailMock(options: ZeptoMailMockOptions): FastifyInstance & { readonly accepted: AcceptedEmail[] } {
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  const accepted: AcceptedEmail[] = [];
  const format = options.errorFormat ?? 'details';

  const fail = (reply: FastifyReply, code: string, target?: string, targetValue?: string) => {
    const message = MESSAGES[code] ?? 'error';
    const body =
      format === 'documented'
        ? { data: { error_code: code, message }, message: 'error' }
        : {
            error: {
              code: TOP_LEVEL[code] ?? 'TM_0000',
              details: [{ code, message, ...(target ? { target } : {}), ...(targetValue ? { target_value: targetValue } : {}) }],
              message: 'Invalid request',
              request_id: randomUUID(),
            },
          };
    return reply.code(400).send(body);
  };

  // Raw body so that invalid JSON reaches the route and becomes SM_101, as documented.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.post('/v1.1/email', async (request, reply) => {
    if (request.headers.authorization !== `Zoho-enczapikey ${options.apiKey}`) return reply.code(401).send();

    let body: SendBody;
    try {
      body = JSON.parse(String(request.body)) as SendBody;
    } catch {
      return fail(reply, 'SM_101');
    }

    const to = (body.to ?? []).map((r) => String(r.email_address?.address ?? ''));
    const bcc = (body.bcc ?? []).map((r) => String(r.email_address?.address ?? ''));
    const scenario = /\+zm-([A-Za-z0-9_]+)@/.exec(to[0] ?? '')?.[1];
    switch (scenario) {
      case 'timeout':
        await delay(options.timeoutMs ?? 60_000);
        break;
      case 'reset':
        request.raw.socket.destroy();
        return reply;
      case '429':
        return reply.code(429).header('retry-after', String(options.retryAfterSeconds ?? 30)).send();
      case '500':
      case '503':
        return reply.code(Number(scenario)).send({ message: 'error' });
      case 'empty200':
        return reply.code(200).send({});
      case undefined:
        break;
      default:
        return fail(reply, scenario, scenario === 'SM_113' ? 'to' : undefined, scenario === 'SM_113' ? to[0] : undefined);
    }

    const from = String(body.from?.address ?? '');
    if (from === '') return fail(reply, 'GE_102', 'from');
    if (to.length === 0) return fail(reply, 'GE_102', 'to');
    if (typeof body.subject !== 'string' || body.subject.trim() === '') return fail(reply, 'GE_102', 'subject');
    if (!EMAIL.test(from)) return fail(reply, 'SM_113', 'from', from);
    if (!options.verifiedDomains.includes(from.split('@')[1] ?? '')) return fail(reply, 'SM_111', 'from', from);
    const badTo = to.find((a) => !EMAIL.test(a));
    if (badTo !== undefined) return fail(reply, 'SM_113', 'to', badTo);
    const badBcc = bcc.find((a) => !EMAIL.test(a));
    if (badBcc !== undefined) return fail(reply, 'SM_113', 'bcc', badBcc);
    if (body.subject.length > 500) return fail(reply, 'SM_129', 'subject');

    const attachments: Array<{ name: string; mimeType: string; bytes: number }> = [];
    for (const attachment of body.attachments ?? []) {
      const name = String(attachment.name ?? '');
      const mimeType = String(attachment.mime_type ?? '');
      const content = Buffer.from(String(attachment.content ?? ''), 'base64');
      if (mimeType !== 'application/pdf' || !content.subarray(0, 5).equals(Buffer.from('%PDF-'))) return fail(reply, 'SM_120', 'attachments');
      if (name.length > 150 || content.length > MAX_ATTACHMENT_BYTES) return fail(reply, 'SM_129', 'attachments');
      attachments.push({ name, mimeType, bytes: content.length });
    }
    if (attachments.length > 60) return fail(reply, 'SM_127', 'attachments');

    const requestId = randomUUID().replaceAll('-', '');
    accepted.push({
      requestId,
      clientReference: typeof body.client_reference === 'string' ? body.client_reference : undefined,
      from,
      to,
      bcc,
      subject: body.subject,
      textbody: typeof body.textbody === 'string' ? body.textbody : undefined,
      attachments,
      acceptedAt: new Date(),
    });
    return reply.code(200).send({
      data: [{ code: 'EM_104', additional_info: [{ to: { email_address: {} } }], message: 'OK' }],
      message: 'OK',
      request_id: requestId,
    });
  });

  return Object.assign(app, { accepted });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createZeptoMailMock({
    apiKey: process.env.MOCK_API_KEY ?? 'dev-key',
    verifiedDomains: (process.env.MOCK_VERIFIED_DOMAINS ?? 'anutibara.com').split(','),
    errorFormat: process.env.MOCK_ERROR_FORMAT === 'documented' ? 'documented' : 'details',
  });
  const port = Number(process.env.PORT ?? '4002');
  await app.listen({ port, host: '127.0.0.1' });
  process.stdout.write(`ZeptoMail mock on http://127.0.0.1:${port}/v1.1\n`);
}
