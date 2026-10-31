import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Outbox1761879600000 implements MigrationInterface {
  name = 'Outbox1761879600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      -- Domain events written in the same transaction as the changes they describe; the relay delivers them.
      CREATE TABLE outbox_events (
        seq            bigserial PRIMARY KEY,
        event_id       text NOT NULL UNIQUE,
        type           text NOT NULL,
        payload        jsonb NOT NULL,
        occurred_at    timestamptz NOT NULL,
        attempts       integer NOT NULL DEFAULT 0,
        last_error     text,
        dispatched_at  timestamptz
      );
      CREATE INDEX outbox_events_pending_idx ON outbox_events (seq) WHERE dispatched_at IS NULL;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE outbox_events;');
  }
}
