import { randomUUID } from 'node:crypto';

import { err, ok } from '../../../domain/shared/result';
import type { Authenticator, Operator, SessionTokens } from '../../../ports/authenticator';
import type { Clock } from '../../../ports/clock';

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 8 * 60 * 60_000;

/** Plain-text users and opaque tokens. Only for tests. */
export class FakeAuthenticator implements Authenticator {
  private readonly access = new Map<string, { operator: Operator; expiresAt: Date }>();
  private readonly refreshes = new Map<string, { operator: Operator; expiresAt: Date }>();

  constructor(
    private readonly users: Readonly<Record<string, string>>,
    private readonly clock: Clock,
  ) {}

  async signIn(username: string, password: string) {
    const expected = this.users[username];
    if (expected === undefined) return err('UNKNOWN_USER' as const);
    if (expected !== password) return err('WRONG_PASSWORD' as const);
    const operator = { operatorId: username, username };
    const refreshExpiresAt = new Date(this.clock.now().getTime() + REFRESH_MS);
    return ok({ operator, tokens: this.issue(operator, refreshExpiresAt) });
  }

  async refresh(refreshToken: string) {
    const session = this.refreshes.get(refreshToken);
    if (!session || session.expiresAt <= this.clock.now()) return err('INVALID_REFRESH_TOKEN' as const);
    this.refreshes.delete(refreshToken);
    return ok({ operator: session.operator, tokens: this.issue(session.operator, session.expiresAt) });
  }

  async verify(accessToken: string) {
    const session = this.access.get(accessToken);
    if (!session || session.expiresAt <= this.clock.now()) return err('INVALID_ACCESS_TOKEN' as const);
    return ok(session.operator);
  }

  private issue(operator: Operator, refreshExpiresAt: Date): SessionTokens {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const accessExpiresAt = new Date(this.clock.now().getTime() + ACCESS_MS);
    this.access.set(accessToken, { operator, expiresAt: accessExpiresAt });
    this.refreshes.set(refreshToken, { operator, expiresAt: refreshExpiresAt });
    return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt };
  }
}
