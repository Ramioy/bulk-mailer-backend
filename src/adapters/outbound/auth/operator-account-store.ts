/** Operator accounts are provisioned directly in the database; the product only reads them. */
export interface OperatorAccount {
  readonly operatorId: string;
  readonly username: string;
  readonly passwordHash: string;
}

export interface OperatorSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly username: string;
  /** SHA-256 of the current refresh token; the token itself is never stored. */
  readonly refreshTokenHash: string;
  readonly createdAt: Date;
  /** Absolute expiry of the session. */
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
}

/** Storage owned by LocalJwtAuthenticator; not a port of the core. */
export interface OperatorAccountStore {
  findAccount(username: string): Promise<OperatorAccount | undefined>;
  createSession(session: OperatorSession): Promise<void>;
  getSession(sessionId: string): Promise<OperatorSession | undefined>;
  findSessionByRefreshHash(refreshTokenHash: string): Promise<OperatorSession | undefined>;
  /** Replaces the refresh token hash only if it is still `expectedHash` (single use). */
  rotateRefresh(sessionId: string, expectedHash: string, newHash: string): Promise<boolean>;
  revokeSession(sessionId: string, at: Date): Promise<void>;
}

export class InMemoryOperatorAccountStore implements OperatorAccountStore {
  private readonly accounts = new Map<string, OperatorAccount>();
  private readonly sessions = new Map<string, OperatorSession>();

  constructor(accounts: readonly OperatorAccount[] = []) {
    for (const account of accounts) this.accounts.set(account.username, account);
  }

  async findAccount(username: string) {
    return this.accounts.get(username);
  }

  async createSession(session: OperatorSession) {
    this.sessions.set(session.sessionId, session);
  }

  async getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  async findSessionByRefreshHash(refreshTokenHash: string) {
    return [...this.sessions.values()].find((s) => s.refreshTokenHash === refreshTokenHash);
  }

  async rotateRefresh(sessionId: string, expectedHash: string, newHash: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.refreshTokenHash !== expectedHash) return false;
    this.sessions.set(sessionId, { ...session, refreshTokenHash: newHash });
    return true;
  }

  async revokeSession(sessionId: string, at: Date) {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) this.sessions.set(sessionId, { ...session, revokedAt: at });
  }
}
