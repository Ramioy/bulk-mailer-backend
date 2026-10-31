import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D31: other valid names under which the same content was uploaded; the receipt is blocked while there is any. */
export class DuplicateConflicts1761894000000 implements MigrationInterface {
  name = 'DuplicateConflicts1761894000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE receipts ADD COLUMN conflicting_names jsonb;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE receipts DROP COLUMN conflicting_names;`);
  }
}
