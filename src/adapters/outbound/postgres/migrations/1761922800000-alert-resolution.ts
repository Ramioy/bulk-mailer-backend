import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D52: alerts are marked resolved when their cause is; acknowledging them stays the operator's. BATCH_STOPPED alerts
 * carry their batch as reference, so a later completion finds them; the existing ones get it from their detail
 * ("<period>/<block> stopped: …").
 */
export class AlertResolution1761922800000 implements MigrationInterface {
  name = 'AlertResolution1761922800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE alerts ADD COLUMN resolved_at timestamptz, ADD COLUMN resolution text;`);
    await q.query(`CREATE INDEX alerts_unresolved_idx ON alerts (type, subject) WHERE resolved_at IS NULL;`);
    await q.query(`UPDATE alerts SET reference = split_part(detail, ' ', 1) WHERE type = 'BATCH_STOPPED' AND reference IS NULL;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX alerts_unresolved_idx;`);
    await q.query(`ALTER TABLE alerts DROP COLUMN resolution, DROP COLUMN resolved_at;`);
  }
}
