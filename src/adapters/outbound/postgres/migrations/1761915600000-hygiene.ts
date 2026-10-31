import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D50: alerts carry a reference (e.g. an attempt id) to be deduplicated without reading their text; attempts get an
 * insertion sequence to break ties of equal start times; finished work can be purged by age.
 */
export class Hygiene1761915600000 implements MigrationInterface {
  name = 'Hygiene1761915600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE alerts ADD COLUMN reference text;`);
    await q.query(`CREATE INDEX alerts_type_reference_idx ON alerts (type, reference) WHERE reference IS NOT NULL;`);
    await q.query(`ALTER TABLE attempts ADD COLUMN seq bigserial;`);
    await q.query(`CREATE INDEX jobs_finished_idx ON jobs (updated_at) WHERE status IN ('DONE', 'FAILED');`);
    await q.query(`CREATE INDEX outbox_events_dispatched_idx ON outbox_events (dispatched_at) WHERE dispatched_at IS NOT NULL;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX outbox_events_dispatched_idx;`);
    await q.query(`DROP INDEX jobs_finished_idx;`);
    await q.query(`ALTER TABLE attempts DROP COLUMN seq;`);
    await q.query(`DROP INDEX alerts_type_reference_idx;`);
    await q.query(`ALTER TABLE alerts DROP COLUMN reference;`);
  }
}
