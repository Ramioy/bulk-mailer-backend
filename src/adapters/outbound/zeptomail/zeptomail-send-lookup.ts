import { normaliseEmail } from '../../../domain/recipient/recipient';
import { logRecipients } from './log-recipients';
import { networkError } from './network-error';
import type { ProviderSendStatus, SendLookup, SendLookupResult } from '../../../ports/send-lookup';
import type { ZohoOAuthTokenProvider } from './zoho-oauth';

export interface ZeptoMailSendLookupOptions {
  /** Same base URL as the send API (`https://cpaas.zoho.com/v1.1`). */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/**
 * Console statuses, normalised (lower case, letters only). Only `delivered` is documented as an API value; the
 * others are the Processed Emails labels (assumption, docs/architecture/decisiones.md, step 9).
 */
const STATUSES: Readonly<Record<string, ProviderSendStatus>> = {
  queued: 'QUEUED',
  processed: 'PROCESSED',
  delivered: 'DELIVERED',
  softbounce: 'SOFT_BOUNCE',
  softbounced: 'SOFT_BOUNCE',
  hardbounce: 'HARD_BOUNCE',
  hardbounced: 'HARD_BOUNCE',
  processfailed: 'PROCESS_FAILED',
};

interface LogEntry {
  readonly email_reference?: unknown;
  readonly request_id?: unknown;
  readonly to?: unknown;
  readonly status?: unknown;
  readonly client_reference?: unknown;
}

type Fetched = { readonly status: number; readonly json: unknown } | { readonly error: string };

/**
 * ZeptoMail logs API (§9.4, OAuth): `GET /email?client_reference=` and `GET /email/email-reference/{ref}`.
 * The list does not return the client reference and its match type is undocumented, so every candidate is
 * confirmed with the specific-email call, which does. Only the given recipient's entry is considered.
 * Anything unexpected is UNAVAILABLE: it never resolves a send by guessing, and above all never answers NOT_FOUND
 * (which fails an UNCERTAIN send) for a list it could not read (D35). Never throws.
 */
export class ZeptoMailSendLookup implements SendLookup {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly options: ZeptoMailSendLookupOptions,
    private readonly tokens: ZohoOAuthTokenProvider,
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  async findByAttempt(attemptId: string, recipient: string): Promise<SendLookupResult> {
    const list = await this.get(`/email?client_reference=${encodeURIComponent(attemptId)}`);
    if ('error' in list) return { kind: 'UNAVAILABLE', detail: list.error };
    // The only "not found" answers (D35): the documented EL_404, or an empty list.
    if (isNotFound(list.json) && (list.status === 400 || list.status === 404)) return { kind: 'NOT_FOUND' };
    if (list.status !== 200) return { kind: 'UNAVAILABLE', detail: `logs API HTTP ${list.status}` };
    const body = list.json as Record<string, unknown> | undefined;
    const data = body?.data;
    if (!Array.isArray(data)) return { kind: 'UNAVAILABLE', detail: 'logs API: unexpected body' };
    if (data.length === 0) return { kind: 'NOT_FOUND' };
    const more = morePages(body, data.length);
    if (more) return { kind: 'UNAVAILABLE', detail: `logs API: ${data.length} entries for the reference and ${more}; not guessing from one page` };

    const wanted = normaliseEmail(recipient);
    // Why entries of this recipient could not be used: any of them could be this send, so none is a "not found".
    const unusable = new Set<string>();
    let ofRecipient = 0;
    for (const raw of data as unknown[]) {
      const candidate = (typeof raw === 'object' && raw !== null ? raw : {}) as LogEntry;
      const recipients = logRecipients(candidate.to);
      if (recipients.length === 0) {
        unusable.add('"to" unreadable');
        continue;
      }
      // Another recipient of the same send (the copy) or of another send.
      if (!recipients.includes(wanted)) continue;
      ofRecipient += 1;
      const reference = typeof candidate.email_reference === 'string' && candidate.email_reference !== '' ? candidate.email_reference : undefined;
      if (!reference) {
        unusable.add('email_reference missing');
        continue;
      }
      const detail = await this.get(`/email/email-reference/${encodeURIComponent(reference)}`);
      if ('error' in detail) return { kind: 'UNAVAILABLE', detail: detail.error };
      if (detail.status === 404 || (detail.status === 400 && isNotFound(detail.json))) {
        unusable.add('detail not found');
        continue;
      }
      if (detail.status !== 200) return { kind: 'UNAVAILABLE', detail: `logs API HTTP ${detail.status}` };
      const entry = (detail.json as { data?: LogEntry } | undefined)?.data;
      if (typeof entry?.client_reference !== 'string') {
        unusable.add('detail without client_reference');
        continue;
      }
      // A partial match of another reference is not this send: a confirmed "other send", not an unusable entry.
      if (entry.client_reference !== attemptId) continue;
      const rawStatus = String(entry.status ?? candidate.status ?? '');
      const status = STATUSES[rawStatus.toLowerCase().replace(/[^a-z]/g, '')];
      if (!status) return { kind: 'UNAVAILABLE', detail: `logs API: undocumented status "${rawStatus}"` };
      return {
        kind: 'FOUND',
        status,
        providerRequestId: typeof entry.request_id === 'string' ? entry.request_id : undefined,
        emailReference: reference,
        detail: rawStatus,
      };
    }
    // Every entry of this recipient was confirmed to be another send (partial match of the reference, §12.7).
    if (ofRecipient > 0 && unusable.size === 0) return { kind: 'NOT_FOUND' };
    if (ofRecipient === 0 && unusable.size === 0) unusable.add(`none for ${wanted}`);
    return { kind: 'UNAVAILABLE', detail: `logs API: ${data.length} entries for the reference, none usable: ${[...unusable].join('; ')}` };
  }

  /** One GET with the OAuth token; a 401 renews the token once (an internal retry: no email is sent). */
  private async get(path: string, renewed = false): Promise<Fetched> {
    const token = await this.tokens.token();
    if (typeof token !== 'string') return token;
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: { authorization: `Zoho-oauthtoken ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return { error: `logs API: ${networkError(error)}` };
    }
    if (response.status === 401 && !renewed) {
      this.tokens.invalidate();
      return this.get(path, true);
    }
    const json = (await response.json().catch(() => undefined)) as unknown;
    return { status: response.status, json };
  }
}

function isNotFound(json: unknown): boolean {
  return (json as { error?: { code?: unknown } } | undefined)?.error?.code === 'EL_404';
}

/**
 * D35: a sign that the list has more entries than this page. The pagination of `GET /email` is not documented
 * (§12.7); any of these fields, at the top level or under `info`/`page_info`, is taken as "there is more".
 */
function morePages(body: Record<string, unknown> | undefined, onPage: number): string | undefined {
  for (const where of [body, body?.info, body?.page_info]) {
    if (typeof where !== 'object' || where === null) continue;
    const fields = where as Record<string, unknown>;
    if (fields.has_more === true || fields.hasMore === true) return 'has_more';
    for (const name of ['total', 'total_count', 'count']) {
      const total = fields[name];
      if (typeof total === 'number' && total > onPage) return `${name} ${total}`;
    }
    for (const name of ['next_offset', 'next', 'next_page']) {
      if (fields[name] !== undefined && fields[name] !== null && fields[name] !== false && fields[name] !== '') return name;
    }
  }
  return undefined;
}
