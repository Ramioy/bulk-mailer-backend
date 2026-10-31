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
 * Forced scenarios: put `+zm-<scenario>` in the recipient's local part (any case), e.g. `admin+zm-LE_102@altos.com`:
 *   timeout · reset · 429 · 500 · 503 · empty200 · LE_101 · LE_102 · SERR_156 · SERR_157 · SM_111 · SM_128 · SM_133 · SMI_115 · AE_101 · SM_113
 *
 * Logs API (https://www.zoho.com/cpaas/help/api/get-email-logs.html and get-specific-email-log.html, read 2026-10-31):
 *
 *   GET /v1.1/email?client_reference=…            Authorization: Zoho-oauthtoken <token>
 *   GET /v1.1/email/email-reference/{reference}
 *   200 → { "data": [{ email_reference, sent_time, subject, from, to, request_id, mailagent_key, status }], "status": "success" }
 *         (the list does not carry client_reference; the specific-email response does, plus opened_time/clicked_time)
 *   400 (list) / 404 (specific) → { "error": { "code": "EL_404", "message": "Email log not found" }, "status": "failure" }
 *   401 → wrong or missing OAuth token
 *
 * OAuth (Zoho Accounts; the CPaaS pages do not document it, assumption): POST /oauth/v2/token with form fields
 *   grant_type=refresh_token, client_id, client_secret, refresh_token → { access_token, expires_in: 3600, api_domain, token_type }
 *   and `{ "error": "invalid_client" }` / `{ "error": "invalid_code" }` (HTTP 200, as Zoho Accounts answers) otherwise.
 *
 * Webhooks (https://www.zoho.com/cpaas/help/webhooks.html): POST to the configured URL, the event JSON as the single
 * form-encoded parameter of the body, `producer-signature: ts=<epoch ms>;s=<url-encoded base64 HMAC>;s-algorithm=HmacSHA256`,
 * HMAC-SHA256 with the Agent's Authentication Key over the decoded parameter value (ts is not signed), plus the optional
 * custom authorization header configured on the webhook.
 *
 * NOT documented by Zoho, so assumed here (docs/architecture/decisiones.md, step 9 assumptions):
 *   - one log entry per recipient (to and bcc), each with its own email_reference;
 *   - the API status strings: `queued`, `processed`, `delivered`, `soft bounce`, `hard bounce`, `process failed`
 *     (only `delivered` appears in the documentation; the rest are the console labels in lower case);
 *   - the webhook JSON: no full example is published. The documented field tree is produced with `event_name`,
 *     `event_message` and `event_data` as arrays, `details` as an array; the recipient of a bounce in `bounced_recipient`,
 *     of a delivery in `delivered_to`; the delivery object `email_delivered`. `softbounce`, `hardbounce`, `fbl_complaint`
 *     and the complaint's `fblFrom` are documented;
 *   - the form parameter name (`MOCK_WEBHOOK_PARAM`, default `data`) and `Content-Type: application/x-www-form-urlencoded`;
 *   - the Authentication Key used as UTF-8 bytes.
 *   `clientReferenceMatch: 'partial'` simulates a substring filter (match type undocumented, §12.7) and `logDelayMs`
 *   the delay before an email shows up in the logs (undocumented, §12.7).
 *
 * Delivery scenarios (recipient local part, e.g. `admin+zm-hardbounce@altos.com`), with `autoEvents` on:
 *   (none) delivered · softbounce (stays) · softhard (soft, then hard) · softdelivered · hardbounce · complaint (delivered,
 *   then complaint) · processfailed (accepted but never processed; no webhook) · nowebhook (delivered, webhook lost)
 *   · nolog (accepted, never visible in the logs)
 * The archive copy (bcc) is always delivered, unless its own local part carries a scenario.
 * The `timeout` scenario answers late but does accept the email: it shows up in the logs (lost response, §9.2).
 *
 * Control endpoint for manual tests: POST /__mock/events { "client_reference", "recipient"?: "to" | "bcc", "event" }
 *   with event delivered · softbounce · hardbounce · complaint · processfailed.
 *
 * Run: node mocks/zeptomail-api.ts  (PORT, MOCK_API_KEY, MOCK_OAUTH_TOKEN, MOCK_VERIFIED_DOMAINS=anutibara.com,
 *   MOCK_WEBHOOK_URL, MOCK_WEBHOOK_KEY, MOCK_WEBHOOK_AUTH_NAME, MOCK_WEBHOOK_AUTH_VALUE, MOCK_WEBHOOK_PARAM,
 *   MOCK_EVENT_DELAY_MS=2000, MOCK_LOG_DELAY_MS=0, MOCK_OAUTH_CLIENT_ID, MOCK_OAUTH_CLIENT_SECRET, MOCK_OAUTH_REFRESH_TOKEN)
 */
import { createHmac, randomUUID } from 'node:crypto';
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
  /** OAuth access token accepted by the logs API; default `dev-oauth-token`. */
  readonly oauthToken?: string;
  /** Client accepted by the simulated Zoho Accounts token endpoint (`POST /oauth/v2/token`). */
  readonly oauthClient?: { readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string };
  readonly mailagentKey?: string;
  /** Milliseconds before an accepted email shows up in the logs; default 0. */
  readonly logDelayMs?: number;
  /** How the logs API matches `client_reference`; default `exact`. */
  readonly clientReferenceMatch?: 'exact' | 'partial';
  readonly webhook?: WebhookTarget;
  /** Emit the delivery scenario's events by itself after each accepted email. Off by default (tests call `emit`). */
  /** `maxDelayMs` (simulation): each event waits a random time between `delayMs` and `maxDelayMs`. */
  readonly autoEvents?: { readonly delayMs: number; readonly maxDelayMs?: number };
  /** Current time; default the system clock. */
  readonly now?: () => Date;
}

export interface WebhookTarget {
  readonly url: string;
  /** Agent Authentication Key (HMAC). */
  readonly authenticationKey: string;
  /** Optional custom header configured on the webhook. */
  readonly authorization?: { readonly name: string; readonly value: string };
  /** Name of the single form-encoded parameter (undocumented); default `data`. */
  readonly parameterName?: string;
}

/** Console status of a recipient, lower case (assumption: only `delivered` is documented as an API value). */
export type LogStatus = 'queued' | 'processed' | 'delivered' | 'soft bounce' | 'hard bounce' | 'process failed';

export type MockDeliveryEvent = 'delivered' | 'softbounce' | 'hardbounce' | 'complaint' | 'processfailed';

/** One recipient of an accepted email, as the logs API shows it. */
export interface MockDelivery {
  readonly emailReference: string;
  readonly requestId: string;
  readonly clientReference?: string;
  readonly recipient: string;
  readonly kind: 'to' | 'bcc';
  status: LogStatus;
  readonly sentAt: Date;
  /** False for the `nolog` scenario. */
  readonly logged: boolean;
}

export interface SentWebhook {
  readonly webhookRequestId: string;
  readonly payload: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** HTTP status answered by the endpoint, or the network error. */
  readonly response: number | string;
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

export interface ZeptoMailMock extends FastifyInstance {
  readonly accepted: AcceptedEmail[];
  readonly deliveries: MockDelivery[];
  readonly webhooks: SentWebhook[];
  /**
   * Applies a delivery event to one recipient of a send (by client reference; `to` by default) and, unless
   * `webhook: false`, posts the signed webhook. Returns the webhook sent, if any.
   */
  emit(clientReference: string, event: MockDeliveryEvent, options?: { readonly recipient?: 'to' | 'bcc'; readonly webhook?: boolean }): Promise<SentWebhook | undefined>;
  /** Waits for the scheduled automatic events (autoEvents) to be posted. */
  settle(): Promise<void>;
  /** OAuth access tokens issued so far. */
  tokensIssued(): number;
  /** Points the webhooks at another endpoint (e.g. an app started after the simulator). */
  setWebhook(target: WebhookTarget | undefined): void;
}

/** Status a recipient reaches with each event; the console never moves a final status back (assumption). */
const STATUS_AFTER: Readonly<Record<MockDeliveryEvent, LogStatus>> = {
  delivered: 'delivered',
  softbounce: 'soft bounce',
  hardbounce: 'hard bounce',
  // a complaint does not change the log status (assumption): the email was delivered
  complaint: 'delivered',
  processfailed: 'process failed',
};

const FINAL_STATUSES: ReadonlySet<LogStatus> = new Set(['delivered', 'hard bounce', 'process failed']);

const DELIVERY_SCENARIOS: Readonly<Record<string, readonly MockDeliveryEvent[]>> = {
  softbounce: ['softbounce'],
  softhard: ['softbounce', 'hardbounce'],
  softdelivered: ['softbounce', 'delivered'],
  hardbounce: ['hardbounce'],
  complaint: ['delivered', 'complaint'],
  processfailed: ['processfailed'],
  nowebhook: ['delivered'],
  nolog: [],
};

export function createZeptoMailMock(options: ZeptoMailMockOptions): ZeptoMailMock {
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  const accepted: AcceptedEmail[] = [];
  const deliveries: MockDelivery[] = [];
  const webhooks: SentWebhook[] = [];
  const pending = new Set<Promise<unknown>>();
  let webhookTarget = options.webhook;
  const format = options.errorFormat ?? 'details';
  const now = options.now ?? (() => new Date());
  const oauthToken = options.oauthToken ?? 'dev-oauth-token';
  const mailagentKey = options.mailagentKey ?? 'mock-agent';
  let tokensIssued = 0;

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
    const scenario = scenarioOf(to[0] ?? '');
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
        if (scenario in DELIVERY_SCENARIOS) break;
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
    const clientReference = typeof body.client_reference === 'string' ? body.client_reference : undefined;
    const sentAt = now();
    const recipients = [...to.map((r) => ({ recipient: r, kind: 'to' as const })), ...bcc.map((r) => ({ recipient: r, kind: 'bcc' as const }))];
    for (const { recipient, kind } of recipients) {
      const own = scenarioOf(recipient);
      const delivery: MockDelivery = {
        emailReference: randomUUID().replaceAll('-', ''),
        requestId,
        clientReference,
        recipient,
        kind,
        status: 'processed',
        sentAt,
        logged: own !== 'nolog',
      };
      deliveries.push(delivery);
      if (options.autoEvents && clientReference !== undefined) {
        const events = DELIVERY_SCENARIOS[own ?? ''] ?? ['delivered'];
        const work = (async () => {
          for (const event of events) {
            const min = options.autoEvents?.delayMs ?? 0;
            const max = Math.max(min, options.autoEvents?.maxDelayMs ?? min);
            await delay(min + Math.round(Math.random() * (max - min)));
            await apply(delivery, event, own !== 'nowebhook' && event !== 'processfailed');
          }
        })().catch(() => undefined);
        pending.add(work);
        void work.finally(() => pending.delete(work));
      }
    }
    accepted.push({
      requestId,
      clientReference,
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

  /** Logs API: OAuth token required (Zoho-oauthtoken, as in the documented samples). */
  const authorised = (authorization: string | undefined) => authorization === `Zoho-oauthtoken ${oauthToken}`;
  const notFound = (reply: FastifyReply, status: 400 | 404) =>
    reply.code(status).send({ error: { code: 'EL_404', message: 'Email log not found' }, status: 'failure' });
  const visible = (d: MockDelivery) => d.logged && now().getTime() - d.sentAt.getTime() >= (options.logDelayMs ?? 0);
  const fromOf = (d: MockDelivery) => accepted.find((a) => a.requestId === d.requestId);
  const logEntry = (d: MockDelivery) => ({
    email_reference: d.emailReference,
    sent_time: d.sentAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    subject: fromOf(d)?.subject ?? '',
    from: fromOf(d)?.from ?? '',
    to: d.recipient,
    request_id: d.requestId,
    mailagent_key: mailagentKey,
    status: d.status,
  });

  app.get('/v1.1/email', async (request, reply) => {
    if (!authorised(request.headers.authorization)) return reply.code(401).send();
    const query = request.query as Record<string, string | undefined>;
    const reference = query.client_reference;
    const flag = (name: string) => (query[name] === undefined ? undefined : query[name] === 'true');
    const matches = deliveries.filter((d) => {
      if (!visible(d)) return false;
      if (reference !== undefined) {
        const own = d.clientReference ?? '';
        if (options.clientReferenceMatch === 'partial' ? !own.includes(reference) : own !== reference) return false;
      }
      if (query.request_id !== undefined && d.requestId !== query.request_id) return false;
      if (query.to !== undefined && (d.kind !== 'to' || d.recipient !== query.to)) return false;
      if (query.recipient !== undefined && d.recipient !== query.recipient) return false;
      if (flag('is_hb') !== undefined && (d.status === 'hard bounce') !== flag('is_hb')) return false;
      if (flag('is_sb') !== undefined && (d.status === 'soft bounce') !== flag('is_sb')) return false;
      if (flag('is_delivered') !== undefined && (d.status === 'delivered') !== flag('is_delivered')) return false;
      if (flag('is_mailfailure') !== undefined && (d.status === 'process failed') !== flag('is_mailfailure')) return false;
      return true;
    });
    const offset = Number(query.offset ?? '0');
    const page = matches.slice(offset, offset + Number(query.limit ?? '25'));
    if (page.length === 0) return notFound(reply, 400);
    return { data: page.map(logEntry), status: 'success' };
  });

  app.get('/v1.1/email/email-reference/:reference', async (request, reply) => {
    if (!authorised(request.headers.authorization)) return reply.code(401).send();
    const { reference } = request.params as { reference: string };
    const d = deliveries.find((x) => x.emailReference === reference && visible(x));
    if (!d) return notFound(reply, 404);
    return { data: { ...logEntry(d), client_reference: d.clientReference ?? '' }, status: 'success' };
  });

  app.post('/oauth/v2/token', async (request) => {
    const form = new URLSearchParams(String(request.body));
    const client = options.oauthClient;
    if (!client || form.get('client_id') !== client.clientId || form.get('client_secret') !== client.clientSecret) return { error: 'invalid_client' };
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== client.refreshToken) return { error: 'invalid_code' };
    tokensIssued += 1;
    return { access_token: oauthToken, api_domain: 'https://www.zohoapis.com', token_type: 'Bearer', expires_in: 3600 };
  });

  app.post('/__mock/events', async (request, reply) => {
    const body = (parseJson(String(request.body)) ?? {}) as { client_reference?: string; recipient?: 'to' | 'bcc'; event?: MockDeliveryEvent };
    if (!body.client_reference || !body.event || !(body.event in STATUS_AFTER)) return reply.code(400).send({ message: 'client_reference and event are required' });
    const sent = await emit(body.client_reference, body.event, { recipient: body.recipient });
    return { status: deliveryOf(body.client_reference, body.recipient ?? 'to')?.status, webhook: sent?.response ?? null };
  });

  const deliveryOf = (clientReference: string, kind: 'to' | 'bcc') => deliveries.find((d) => d.clientReference === clientReference && d.kind === kind);

  async function apply(delivery: MockDelivery, event: MockDeliveryEvent, sendWebhook: boolean): Promise<SentWebhook | undefined> {
    // final statuses do not move back (assumption)
    if (!FINAL_STATUSES.has(delivery.status)) delivery.status = STATUS_AFTER[event];
    if (!sendWebhook || event === 'processfailed' || !webhookTarget) return undefined;
    return postWebhook(webhookTarget, webhookPayload(delivery, event));
  }

  async function emit(
    clientReference: string,
    event: MockDeliveryEvent,
    emitOptions: { readonly recipient?: 'to' | 'bcc'; readonly webhook?: boolean } = {},
  ): Promise<SentWebhook | undefined> {
    const delivery = deliveryOf(clientReference, emitOptions.recipient ?? 'to');
    if (!delivery) throw new Error(`No ${emitOptions.recipient ?? 'to'} recipient sent with client reference ${clientReference}`);
    return apply(delivery, event, emitOptions.webhook ?? true);
  }

  function webhookPayload(delivery: MockDelivery, event: Exclude<MockDeliveryEvent, 'processfailed'>): Record<string, unknown> {
    const email = fromOf(delivery);
    const at = now().toISOString();
    const object = event === 'complaint' ? 'fbl_complaint' : event === 'delivered' ? 'email_delivered' : event;
    const details =
      event === 'complaint'
        ? { fblFrom: delivery.recipient, returnPath: email?.from ?? '', ip: '203.0.113.10', from: email?.from ?? '', to: delivery.recipient, time: at }
        : event === 'delivered'
          ? { delivered_to: delivery.recipient, time: at }
          : {
              bounced_recipient: delivery.recipient,
              reason: event === 'hardbounce' ? 'Mailbox does not exist' : 'Mailbox full',
              diagnostic_message: event === 'hardbounce' ? '550 5.1.1 User unknown' : '452 4.2.2 Mailbox full',
              time: at,
            };
    return {
      event_name: [object],
      event_message: [
        {
          email_info: {
            email_reference: delivery.emailReference,
            client_reference: delivery.clientReference ?? '',
            is_smtp_trigger: false,
            subject: email?.subject ?? '',
            bounce_address: '',
            from: { address: email?.from ?? '', name: '' },
            to: (email?.to ?? []).map((address) => ({ email_address: { address, name: '' } })),
            ...(email && email.bcc.length > 0 ? { bcc: email.bcc.map((address) => ({ email_address: { address, name: '' } })) } : {}),
            processed_time: delivery.sentAt.toISOString(),
            object: 'email',
          },
          event_data: [{ details: [details], object }],
          request_id: delivery.requestId,
        },
      ],
      mailagent_key: mailagentKey,
      webhook_request_id: randomUUID().replaceAll('-', ''),
    };
  }

  async function postWebhook(target: WebhookTarget, payload: Record<string, unknown>): Promise<SentWebhook> {
    const json = JSON.stringify(payload);
    const body = `${target.parameterName ?? 'data'}=${encodeURIComponent(json)}`;
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      'producer-signature': signWebhook(json, target.authenticationKey, now().getTime()),
      ...(target.authorization ? { [target.authorization.name.toLowerCase()]: target.authorization.value } : {}),
    };
    let response: number | string;
    try {
      response = (await fetch(target.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })).status;
    } catch (error) {
      response = String((error as { cause?: { code?: string } }).cause?.code ?? error);
    }
    const sent: SentWebhook = { webhookRequestId: String(payload.webhook_request_id), payload, headers, body, response };
    webhooks.push(sent);
    return sent;
  }

  const settle = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  return Object.assign(app, { accepted, deliveries, webhooks, emit, settle, tokensIssued: () => tokensIssued,
    setWebhook: (target: WebhookTarget | undefined) => {
      webhookTarget = target;
    },
  });
}

/** `producer-signature` value: base64 HMAC-SHA256 of the decoded parameter, URL-encoded as in the documented sample. */
export function signWebhook(decodedParameter: string, authenticationKey: string, ts: number): string {
  const s = createHmac('sha256', Buffer.from(authenticationKey, 'utf8')).update(decodedParameter, 'utf8').digest('base64');
  return `ts=${ts};s=${encodeURIComponent(s)};s-algorithm=HmacSHA256`;
}

/**
 * Scenario in the local part, case-insensitive: the application lower-cases addresses (§6), so `+zm-sm_113` must
 * still answer the documented code `SM_113`. Error codes are canonical in upper case; the other scenarios in lower case.
 */
function scenarioOf(address: string): string | undefined {
  const raw = /\+zm-([A-Za-z0-9_]+)@/.exec(address)?.[1];
  if (raw === undefined) return undefined;
  return raw.toUpperCase() in MESSAGES ? raw.toUpperCase() : raw.toLowerCase();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createZeptoMailMock({
    apiKey: process.env.MOCK_API_KEY ?? 'dev-key',
    verifiedDomains: (process.env.MOCK_VERIFIED_DOMAINS ?? 'anutibara.com').split(','),
    errorFormat: process.env.MOCK_ERROR_FORMAT === 'documented' ? 'documented' : 'details',
    oauthToken: process.env.MOCK_OAUTH_TOKEN ?? 'dev-oauth-token',
    oauthClient: {
      clientId: process.env.MOCK_OAUTH_CLIENT_ID ?? 'dev-client',
      clientSecret: process.env.MOCK_OAUTH_CLIENT_SECRET ?? 'dev-secret',
      refreshToken: process.env.MOCK_OAUTH_REFRESH_TOKEN ?? 'dev-refresh',
    },
    logDelayMs: Number(process.env.MOCK_LOG_DELAY_MS ?? '0'),
    ...(process.env.MOCK_WEBHOOK_URL
      ? {
          webhook: {
            url: process.env.MOCK_WEBHOOK_URL,
            authenticationKey: process.env.MOCK_WEBHOOK_KEY ?? 'dev-webhook-key',
            ...(process.env.MOCK_WEBHOOK_AUTH_NAME
              ? { authorization: { name: process.env.MOCK_WEBHOOK_AUTH_NAME, value: process.env.MOCK_WEBHOOK_AUTH_VALUE ?? '' } }
              : {}),
            parameterName: process.env.MOCK_WEBHOOK_PARAM ?? 'data',
          },
        }
      : {}),
    autoEvents: { delayMs: Number(process.env.MOCK_EVENT_DELAY_MS ?? '2000'), maxDelayMs: Number(process.env.MOCK_EVENT_DELAY_MAX_MS ?? process.env.MOCK_EVENT_DELAY_MS ?? '2000') },
  });
  const port = Number(process.env.PORT ?? '4002');
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  process.stdout.write(`ZeptoMail mock on http://${host}:${port}/v1.1\n`);
}
