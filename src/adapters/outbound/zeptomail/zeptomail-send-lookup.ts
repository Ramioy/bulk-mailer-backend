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
 * Anything unexpected is UNAVAILABLE: it never resolves a send by guessing. Never throws.
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
    if (isNotFound(list.json) && (list.status === 400 || list.status === 404)) return { kind: 'NOT_FOUND' };
    if (list.status !== 200) return { kind: 'UNAVAILABLE', detail: `logs API HTTP ${list.status}` };
    const data = (list.json as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) return { kind: 'UNAVAILABLE', detail: 'logs API: unexpected body' };

    const candidates = (data as LogEntry[]).filter((e) => typeof e.to === 'string' && e.to.toLowerCase() === recipient.toLowerCase());
    for (const candidate of candidates) {
      const reference = typeof candidate.email_reference === 'string' ? candidate.email_reference : undefined;
      if (!reference) continue;
      const detail = await this.get(`/email/email-reference/${encodeURIComponent(reference)}`);
      if ('error' in detail) return { kind: 'UNAVAILABLE', detail: detail.error };
      if (detail.status === 404 || (detail.status === 400 && isNotFound(detail.json))) continue;
      if (detail.status !== 200) return { kind: 'UNAVAILABLE', detail: `logs API HTTP ${detail.status}` };
      const entry = (detail.json as { data?: LogEntry } | undefined)?.data;
      // A partial match of another reference is not this send.
      if (entry?.client_reference !== attemptId) continue;
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
    return { kind: 'NOT_FOUND' };
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
