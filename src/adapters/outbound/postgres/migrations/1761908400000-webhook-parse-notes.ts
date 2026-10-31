import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D45: what the webhook parser could not use and why, kept with the raw webhook for the operator. */
export class WebhookParseNotes1761908400000 implements MigrationInterface {
  name = 'WebhookParseNotes1761908400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE webhook_events ADD COLUMN parse_notes jsonb;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE webhook_events DROP COLUMN parse_notes;`);
  }
}
