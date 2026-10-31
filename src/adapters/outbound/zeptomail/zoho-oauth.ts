import { networkError } from './network-error';
export interface ZohoOAuthOptions {
  /** Zoho Accounts of the account's data centre; default `https://accounts.zoho.com` (assumption, §12.7). */
  readonly accountsUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Long-lived refresh token of the self client, with scope `Zeptomail.email.READ`. */
  readonly refreshToken: string;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

/** Renew this long before expiry. */
const MARGIN_MS = 60_000;

/**
 * OAuth 2.0 access tokens for the ZeptoMail APIs that do not take the send API key (logs; §12.2). Refresh-token
 * grant against Zoho Accounts; the token (1 hour) is cached and renewed before it expires. Never throws.
 */
export class ZohoOAuthTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string | { error: string }> | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ZohoOAuthOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** A valid access token, or the reason it could not be obtained. */
  async token(): Promise<string | { error: string }> {
    if (this.cached && this.cached.expiresAt - MARGIN_MS > this.now()) return this.cached.token;
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** The API refused the token (401): forget it so the next call asks for a new one. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async refresh(): Promise<string | { error: string }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
    });
    try {
      const response = await this.fetch(`${this.options.accountsUrl.replace(/\/+$/, '')}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const json = (await response.json().catch(() => undefined)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | undefined;
      if (response.ok && typeof json?.access_token === 'string') {
        const seconds = typeof json.expires_in === 'number' ? json.expires_in : 3600;
        this.cached = { token: json.access_token, expiresAt: this.now() + seconds * 1000 };
        return json.access_token;
      }
      return { error: `OAuth token: HTTP ${response.status}${typeof json?.error === 'string' ? ` ${json.error}` : ''}` };
    } catch (error) {
      return { error: `OAuth token: ${networkError(error)}` };
    }
  }
}
