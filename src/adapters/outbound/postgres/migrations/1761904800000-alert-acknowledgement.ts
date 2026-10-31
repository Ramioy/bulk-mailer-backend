import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D46: alerts can be acknowledged, and are looked up by type and subject without reading the whole history. */
export class AlertAcknowledgement1761904800000 implements MigrationInterface {
  name = 'AlertAcknowledgement1761904800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE alerts ADD COLUMN acknowledged_at timestamptz, ADD COLUMN acknowledged_by text;`);
    await q.query(`CREATE INDEX alerts_type_subject_idx ON alerts (type, subject);`);
    await q.query(`CREATE INDEX alerts_pending_idx ON alerts (seq) WHERE acknowledged_at IS NULL;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX alerts_pending_idx;`);
    await q.query(`DROP INDEX alerts_type_subject_idx;`);
    await q.query(`ALTER TABLE alerts DROP COLUMN acknowledged_by, DROP COLUMN acknowledged_at;`);
  }
}
