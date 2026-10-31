import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D47: the lease of the instance that runs the background work; one row at most. */
export class InstanceLease1761912000000 implements MigrationInterface {
  name = 'InstanceLease1761912000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE instance_lease (
        id          smallint PRIMARY KEY CHECK (id = 1),
        holder      text NOT NULL,
        expires_at  timestamptz NOT NULL
      );
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE instance_lease;`);
  }
}
