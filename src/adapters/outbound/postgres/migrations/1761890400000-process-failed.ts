import type { MigrationInterface, QueryRunner } from 'typeorm';

const BEFORE = `'UNCONFIRMED','SOFT_BOUNCE','ACCEPTED','HARD_BOUNCE','COMPLAINT'`;
const AFTER = `${BEFORE},'PROCESS_FAILED'`;

/** M2: delivery state PROCESS_FAILED (accepted by the provider, then not processed). */
export class ProcessFailed1761890400000 implements MigrationInterface {
  name = 'ProcessFailed1761890400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE receipts DROP CONSTRAINT receipts_delivery_state_check,
        ADD CONSTRAINT receipts_delivery_state_check CHECK (delivery_state IN (${AFTER}));
      ALTER TABLE delivery_events DROP CONSTRAINT delivery_events_state_check,
        ADD CONSTRAINT delivery_events_state_check CHECK (state IN (${AFTER}));
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE receipts DROP CONSTRAINT receipts_delivery_state_check,
        ADD CONSTRAINT receipts_delivery_state_check CHECK (delivery_state IN (${BEFORE}));
      ALTER TABLE delivery_events DROP CONSTRAINT delivery_events_state_check,
        ADD CONSTRAINT delivery_events_state_check CHECK (state IN (${BEFORE}));
    `);
  }
}
