import type { SendOutcome } from '../../../domain/sending/send-outcome';
import type { EmailProvider, OutgoingEmail } from '../../../ports/email-provider';

export interface ZeptoMailOptions {
  /** Default `https://cpaas.zoho.com/v1.1` (configurable: the account's data centre is to be confirmed, §12.7). */
  readonly baseUrl: string;
  /** Send Mail API key of the Bulk Mailer Agent. */
  readonly apiKey: string;
  readonly from: { readonly address: string; readonly name?: string };
  readonly bounceAddress?: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** Account or configuration: the batch stops (§12.4). */
const ACCOUNT_CODES = new Set(['LE_101', 'LE_102', 'SERR_156', 'SERR_157', 'SM_111', 'SM_128', 'SM_133', 'SMI_115', 'AE_101']);
/** This receipt only: the batch continues. SM_113 is handled by its target. */
const RECEIPT_CODES = new Set(['SM_120', 'SM_127', 'SM_129']);
/** Our request is wrong: the batch stops. */
const REQUEST_CODES = new Set(['SM_101', 'GE_102', 'UE_106', 'MTR_101']);
/** SM_113 on these fields is configuration (sender, bounce address, archive copy), not the receipt's recipient. */
const CONFIGURATION_TARGETS = new Set(['from', 'bounce_address', 'bcc']);

/** Errors raised before the request left: certainty that nothing was sent. */
const CONNECTION_ERRORS = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

interface ErrorDetail {
  readonly code: string;
  readonly target?: string;
  readonly message?: string;
}

/**
 * ZeptoMail send API (`POST /email`). Classifies every response into a provider-neutral SendOutcome
 * (docs/context/12-email-provider-zeptomail.md §12.4); an undocumented 400 is UNKNOWN_REJECTION (M1), anything else
 * undocumented is UNCERTAIN. Never throws.
 */
export class ZeptoMailEmailProvider implements EmailProvider {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ZeptoMailOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/email`, {
        method: 'POST',
        headers: {
          authorization: `Zoho-enczapikey ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(this.body(email)),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') return { kind: 'UNCERTAIN', detail: `timeout after ${this.options.timeoutMs} ms` };
      const code = errorCode(error);
      if (code && CONNECTION_ERRORS.has(code)) return { kind: 'CONNECTION_FAILED', detail: code };
      return { kind: 'UNCERTAIN', detail: `network: ${code ?? String(error)}` };
    }

    const text = await response.text().catch(() => '');
    const json = parseJson(text);

    if (response.status === 200) {
      const data = (json as { data?: Array<{ code?: unknown }>; request_id?: unknown } | undefined)?.data;
      if (Array.isArray(data) && data[0]?.code === 'EM_104') {
        return { kind: 'ACCEPTED', providerRequestId: String((json as { request_id?: unknown }).request_id ?? '') };
      }
      return { kind: 'UNCERTAIN', detail: `HTTP 200 without EM_104: ${text.slice(0, 200)}` };
    }
    if (response.status === 401) return { kind: 'ACCOUNT_ERROR', detail: 'HTTP 401 unauthorized (API key)' };
    if (response.status === 429 || response.status >= 500) {
      return { kind: 'UNCERTAIN', detail: `HTTP ${response.status}`, retryAfterSeconds: retryAfter(response.headers.get('retry-after')) };
    }
    if (response.status === 400) return classify(errorDetails(json), text);
    return { kind: 'UNCERTAIN', detail: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }

  private body(email: OutgoingEmail) {
    return {
      from: this.options.from,
      to: [{ email_address: { address: email.to } }],
      ...(email.copyTo ? { bcc: [{ email_address: { address: email.copyTo } }] } : {}),
      subject: email.subject,
      textbody: email.textBody,
      attachments: [{ name: email.attachment.name, mime_type: 'application/pdf', content: Buffer.from(email.attachment.content).toString('base64') }],
      client_reference: email.attemptId,
      track_opens: false,
      track_clicks: false,
      ...(this.options.bounceAddress ? { bounce_address: this.options.bounceAddress } : {}),
    };
  }
}

function classify(details: ErrorDetail[], raw: string): SendOutcome {
  const detail = details.map((d) => `${d.code}${d.target ? `(${d.target})` : ''}${d.message ? ` ${d.message}` : ''}`).join('; ') || raw.slice(0, 200);
  const codes = details.map((d) => d.code);
  if (codes.some((c) => ACCOUNT_CODES.has(c))) return { kind: 'ACCOUNT_ERROR', detail };
  if (codes.some((c) => REQUEST_CODES.has(c))) return { kind: 'REQUEST_ERROR', detail };
  const invalidAddress = details.find((d) => d.code === 'SM_113');
  if (invalidAddress) {
    return CONFIGURATION_TARGETS.has(invalidAddress.target ?? '') ? { kind: 'ACCOUNT_ERROR', detail } : { kind: 'RECEIPT_REJECTED', detail };
  }
  if (codes.some((c) => RECEIPT_CODES.has(c))) return { kind: 'RECEIPT_REJECTED', detail };
  // A 400 is a rejection: the email was not sent, whatever the code (M1).
  return { kind: 'UNKNOWN_REJECTION', detail: `undocumented HTTP 400: ${detail}` };
}

/** Sub-codes from either known body: `{ error: { details: [{ code, target }] } }` or `{ data: { error_code } }`. */
function errorDetails(json: unknown): ErrorDetail[] {
  const body = json as
    | { error?: { code?: unknown; details?: Array<{ code?: unknown; target?: unknown; message?: unknown }> }; data?: { error_code?: unknown; message?: unknown } }
    | undefined;
  const details: ErrorDetail[] = [];
  for (const d of body?.error?.details ?? []) {
    if (typeof d.code === 'string') {
      details.push({ code: d.code, target: typeof d.target === 'string' ? d.target : undefined, message: typeof d.message === 'string' ? d.message : undefined });
    }
  }
  if (typeof body?.data?.error_code === 'string') {
    details.push({ code: body.data.error_code, message: typeof body.data.message === 'string' ? body.data.message : undefined });
  }
  if (details.length === 0 && typeof body?.error?.code === 'string') details.push({ code: body.error.code });
  return details;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Seconds or HTTP date. */
function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; cause?: { code?: string } } }).cause;
  return cause?.code ?? cause?.cause?.code;
}
