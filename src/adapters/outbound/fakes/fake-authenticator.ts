import { randomUUID } from 'node:crypto';

import { err, ok } from '../../../domain/shared/result';
import type { Authenticator, Operator, SignedIn } from '../../../ports/authenticator';
import type { Clock } from '../../../ports/clock';

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 8 * 60 * 60_000;

interface Session {
  readonly sessionId: string;
  readonly operator: Operator;
  readonly expiresAt: Date;
  revoked: boolean;
}

/** Plain-text users and opaque tokens. Only for tests. */
export class FakeAuthenticator implements Authenticator {
  private readonly access = new Map<string, { session: Session; expiresAt: Date }>();
  private readonly refreshes = new Map<string, Session>();

  constructor(
    private readonly users: Readonly<Record<string, string>>,
    private readonly clock: Clock,
  ) {}

  async signIn(username: string, password: string) {
    const expected = this.users[username];
    if (expected === undefined) return err('UNKNOWN_USER' as const);
    if (expected !== password) return err('WRONG_PASSWORD' as const);
    const session: Session = {
      sessionId: randomUUID(),
      operator: { operatorId: username, username },
      expiresAt: new Date(this.clock.now().getTime() + REFRESH_MS),
      revoked: false,
    };
    return ok(this.issue(session));
  }

  async refresh(refreshToken: string) {
    const session = this.refreshes.get(refreshToken);
    if (!session || session.revoked || session.expiresAt <= this.clock.now()) return err('INVALID_REFRESH_TOKEN' as const);
    this.refreshes.delete(refreshToken);
    return ok(this.issue(session));
  }

  async verify(accessToken: string) {
    const entry = this.access.get(accessToken);
    if (!entry || entry.session.revoked || entry.expiresAt <= this.clock.now()) return err('INVALID_ACCESS_TOKEN' as const);
    return ok({ ...entry.session.operator, sessionId: entry.session.sessionId, accessExpiresAt: entry.expiresAt });
  }

  async signOut(refreshToken: string) {
    const session = this.refreshes.get(refreshToken);
    if (!session) return undefined;
    session.revoked = true;
    this.refreshes.delete(refreshToken);
    return session.operator;
  }

  private issue(session: Session): SignedIn {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const accessExpiresAt = new Date(this.clock.now().getTime() + ACCESS_MS);
    this.access.set(accessToken, { session, expiresAt: accessExpiresAt });
    this.refreshes.set(refreshToken, session);
    return {
      operator: session.operator,
      sessionId: session.sessionId,
      tokens: { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt: session.expiresAt },
    };
  }
}
