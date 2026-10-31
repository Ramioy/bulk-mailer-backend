import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { err, ok, type Result } from '../../../domain/shared/result';
import type { AuthenticatedOperator, Authenticator, Operator, SignedIn, SignInError } from '../../../ports/authenticator';
import type { Clock } from '../../../ports/clock';
import { signJwt, verifyJwt } from './jwt';
import type { OperatorAccountStore, OperatorSession } from './operator-account-store';
import { verifyPassword } from './password-hasher';

export interface LocalJwtOptions {
  /** HMAC key for access tokens, at least 32 bytes. */
  readonly signingKey: Buffer;
  readonly accessTokenMinutes: number;
  readonly sessionHours: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

/**
 * Username + password (argon2id), short-lived JWT access tokens and single-use refresh tokens
 * whose session has an absolute expiry. Sessions live in the database so they can be signed out.
 */
export class LocalJwtAuthenticator implements Authenticator {
  constructor(
    private readonly store: OperatorAccountStore,
    private readonly clock: Clock,
    private readonly options: LocalJwtOptions,
  ) {
    if (options.signingKey.length < 32) throw new Error('JWT signing key must be at least 32 bytes');
  }

  async signIn(username: string, password: string): Promise<Result<SignedIn, SignInError>> {
    const account = await this.store.findAccount(username);
    if (!account) return err('UNKNOWN_USER');
    if (!(await verifyPassword(password, account.passwordHash))) return err('WRONG_PASSWORD');

    const now = this.clock.now();
    const refreshToken = newRefreshToken();
    const session: OperatorSession = {
      sessionId: randomUUID(),
      operatorId: account.operatorId,
      username: account.username,
      refreshTokenHash: sha256(refreshToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.options.sessionHours * 3_600_000),
    };
    await this.store.createSession(session);
    return ok(this.issue(session, refreshToken));
  }

  async refresh(refreshToken: string): Promise<Result<SignedIn, 'INVALID_REFRESH_TOKEN'>> {
    const presentedHash = sha256(refreshToken);
    const session = await this.store.findSessionByRefreshHash(presentedHash);
    if (!session || !this.isLive(session)) return err('INVALID_REFRESH_TOKEN');

    const next = newRefreshToken();
    if (!(await this.store.rotateRefresh(session.sessionId, presentedHash, sha256(next)))) return err('INVALID_REFRESH_TOKEN');
    return ok(this.issue(session, next));
  }

  async verify(accessToken: string): Promise<Result<AuthenticatedOperator, 'INVALID_ACCESS_TOKEN'>> {
    const claims = verifyJwt(accessToken, this.options.signingKey, this.clock.now());
    if (!claims) return err('INVALID_ACCESS_TOKEN');
    // Checked on every request so that signing out takes effect at once.
    const session = await this.store.getSession(claims.sid);
    if (!session || !this.isLive(session)) return err('INVALID_ACCESS_TOKEN');
    return ok({ operatorId: claims.sub, username: claims.username, sessionId: claims.sid, accessExpiresAt: new Date(claims.exp * 1000) });
  }

  async signOut(refreshToken: string): Promise<Operator | undefined> {
    const session = await this.store.findSessionByRefreshHash(sha256(refreshToken));
    if (!session || session.revokedAt) return undefined;
    await this.store.revokeSession(session.sessionId, this.clock.now());
    return { operatorId: session.operatorId, username: session.username };
  }

  private isLive(session: OperatorSession): boolean {
    return session.revokedAt === undefined && session.expiresAt > this.clock.now();
  }

  private issue(session: OperatorSession, refreshToken: string): SignedIn {
    const now = this.clock.now();
    const iat = Math.floor(now.getTime() / 1000);
    // The access token never outlives its session.
    const exp = Math.min(iat + this.options.accessTokenMinutes * 60, Math.floor(session.expiresAt.getTime() / 1000));
    const accessToken = signJwt({ sub: session.operatorId, username: session.username, sid: session.sessionId, iat, exp }, this.options.signingKey);
    return {
      operator: { operatorId: session.operatorId, username: session.username },
      sessionId: session.sessionId,
      tokens: { accessToken, accessExpiresAt: new Date(exp * 1000), refreshToken, refreshExpiresAt: session.expiresAt },
    };
  }
}
