import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D37: row versions for optimistic concurrency on receipts and batches; existing rows start at 1. */
export class OptimisticVersions1761897600000 implements MigrationInterface {
  name = 'OptimisticVersions1761897600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE receipts ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);`);
    await q.query(`ALTER TABLE batches ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE batches DROP COLUMN version;`);
    await q.query(`ALTER TABLE receipts DROP COLUMN version;`);
  }
}
