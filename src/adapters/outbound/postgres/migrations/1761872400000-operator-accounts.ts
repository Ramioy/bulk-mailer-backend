import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OperatorAccounts1761872400000 implements MigrationInterface {
  name = 'OperatorAccounts1761872400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      -- Provisioned directly by the deployment team (hash from \`pnpm hash-password\`). No seeded accounts.
      CREATE TABLE operator_accounts (
        operator_id    text PRIMARY KEY,
        username       text NOT NULL UNIQUE,
        password_hash  text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
        created_at     timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE operator_sessions (
        session_id          uuid PRIMARY KEY,
        operator_id         text NOT NULL REFERENCES operator_accounts (operator_id),
        refresh_token_hash  char(64) NOT NULL UNIQUE,
        created_at          timestamptz NOT NULL,
        expires_at          timestamptz NOT NULL,
        revoked_at          timestamptz,
        CHECK (expires_at > created_at)
      );
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE operator_sessions, operator_accounts;');
  }
}
