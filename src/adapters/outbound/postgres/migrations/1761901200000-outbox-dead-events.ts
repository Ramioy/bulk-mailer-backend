import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D39: an event the relay gave up on is marked dead and leaves the pending window, so it cannot block the events
 * behind it. Events already at the old limit of 10 attempts are dead from now on.
 */
export class OutboxDeadEvents1761901200000 implements MigrationInterface {
  name = 'OutboxDeadEvents1761901200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE outbox_events ADD COLUMN dead_at timestamptz;`);
    await q.query(`UPDATE outbox_events SET dead_at = now() WHERE dispatched_at IS NULL AND attempts >= 10;`);
    await q.query(`DROP INDEX outbox_events_pending_idx;`);
    await q.query(`CREATE INDEX outbox_events_pending_idx ON outbox_events (seq) WHERE dispatched_at IS NULL AND dead_at IS NULL;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX outbox_events_pending_idx;`);
    await q.query(`CREATE INDEX outbox_events_pending_idx ON outbox_events (seq) WHERE dispatched_at IS NULL;`);
    await q.query(`ALTER TABLE outbox_events DROP COLUMN dead_at;`);
  }
}
