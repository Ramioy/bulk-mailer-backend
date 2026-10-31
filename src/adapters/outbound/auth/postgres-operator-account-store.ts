import type { DataSource } from 'typeorm';

import { autocommit, firstRow, opt, rows, type Queryable, type Row } from '../postgres/queryable';
import type { OperatorAccount, OperatorAccountStore, OperatorSession } from './operator-account-store';

const toSession = (r: Row): OperatorSession => ({
  sessionId: r.session_id as string,
  operatorId: r.operator_id as string,
  username: r.username as string,
  refreshTokenHash: r.refresh_token_hash as string,
  createdAt: r.created_at as Date,
  expiresAt: r.expires_at as Date,
  revokedAt: opt(r.revoked_at),
});

const SESSION_SELECT = `SELECT s.*, a.username FROM operator_sessions s JOIN operator_accounts a USING (operator_id)`;

export class PostgresOperatorAccountStore implements OperatorAccountStore {
  private readonly db: Queryable;

  constructor(dataSource: DataSource) {
    this.db = autocommit(dataSource);
  }

  async findAccount(username: string): Promise<OperatorAccount | undefined> {
    const r = await firstRow(this.db, 'SELECT * FROM operator_accounts WHERE username = $1', [username]);
    return r && { operatorId: r.operator_id as string, username: r.username as string, passwordHash: r.password_hash as string };
  }

  async createSession(s: OperatorSession): Promise<void> {
    await this.db.query(
      `INSERT INTO operator_sessions (session_id, operator_id, refresh_token_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [s.sessionId, s.operatorId, s.refreshTokenHash, s.createdAt, s.expiresAt],
    );
  }

  async getSession(sessionId: string): Promise<OperatorSession | undefined> {
    const r = await firstRow(this.db, `${SESSION_SELECT} WHERE s.session_id = $1`, [sessionId]);
    return r && toSession(r);
  }

  async findSessionByRefreshHash(hash: string): Promise<OperatorSession | undefined> {
    const r = await firstRow(this.db, `${SESSION_SELECT} WHERE s.refresh_token_hash = $1`, [hash]);
    return r && toSession(r);
  }

  async rotateRefresh(sessionId: string, expectedHash: string, newHash: string): Promise<boolean> {
    const updated = await rows(
      this.db,
      `UPDATE operator_sessions SET refresh_token_hash = $3 WHERE session_id = $1 AND refresh_token_hash = $2 RETURNING session_id`,
      [sessionId, expectedHash, newHash],
    );
    return updated.length === 1;
  }

  async revokeSession(sessionId: string, at: Date): Promise<void> {
    await this.db.query('UPDATE operator_sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL', [sessionId, at]);
  }
}
