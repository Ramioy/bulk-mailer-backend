import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ExecutionEvents1761876000000 implements MigrationInterface {
  name = 'ExecutionEvents1761876000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      -- Progress of each execution, kept so a new session can catch up and SSE can resume (D10, D11).
      CREATE TABLE execution_events (
        seq           bigserial PRIMARY KEY,
        execution_id  text NOT NULL REFERENCES executions (execution_id),
        at            timestamptz NOT NULL,
        type          text NOT NULL,
        payload       jsonb NOT NULL
      );
      CREATE INDEX execution_events_execution_idx ON execution_events (execution_id, seq);
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE execution_events;');
  }
}
