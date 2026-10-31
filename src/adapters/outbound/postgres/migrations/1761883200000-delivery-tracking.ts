import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DeliveryTracking1761883200000 implements MigrationInterface {
  name = 'DeliveryTracking1761883200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      -- Raw provider webhooks, kept permanently; a repeated webhook_request_id is a duplicate.
      CREATE TABLE webhook_events (
        webhook_request_id  text PRIMARY KEY,
        provider            text NOT NULL,
        received_at         timestamptz NOT NULL,
        body                text NOT NULL,
        events              jsonb NOT NULL,
        processed_at        timestamptz
      );

      -- Where each delivery state was learnt: a webhook or the provider logs (reconciliation).
      ALTER TABLE delivery_events
        ADD COLUMN source text NOT NULL DEFAULT 'WEBHOOK' CHECK (source IN ('WEBHOOK','LOGS')),
        ADD COLUMN provider_request_id text,
        ADD COLUMN email_reference text;

      CREATE INDEX attempts_execution_idx ON attempts (execution_id, started_at);
      CREATE INDEX executions_finished_idx ON executions (finished_at);
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP INDEX executions_finished_idx;
      DROP INDEX attempts_execution_idx;
      ALTER TABLE delivery_events DROP COLUMN email_reference, DROP COLUMN provider_request_id, DROP COLUMN source;
      DROP TABLE webhook_events;
    `);
  }
}
