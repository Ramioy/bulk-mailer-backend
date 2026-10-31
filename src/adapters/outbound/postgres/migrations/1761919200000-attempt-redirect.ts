import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D50 (B6): the test mailbox an attempt was redirected to outside production. */
export class AttemptRedirect1761919200000 implements MigrationInterface {
  name = 'AttemptRedirect1761919200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE attempts ADD COLUMN redirected_to text;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE attempts DROP COLUMN redirected_to;`);
  }
}
