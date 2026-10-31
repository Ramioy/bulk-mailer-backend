import type { DataSource } from 'typeorm';

import { createDataSource } from '../../src/adapters/outbound/postgres/data-source';

/** Integration tests run only when TEST_DATABASE_URL points to a disposable PostgreSQL 18 database. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Drops everything and applies the migrations from scratch. Refuses databases whose name does not end in `_test`. */
export async function migratedDataSource(url: string): Promise<DataSource> {
  const database = new URL(url).pathname.slice(1);
  if (!database.endsWith('_test')) throw new Error(`Refusing to wipe "${database}": test databases must end in _test`);
  const dataSource = await createDataSource(url).initialize();
  await dataSource.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await dataSource.runMigrations();
  return dataSource;
}

/** Empties every table and restores the seed rows of the migration. Test-only: bypasses the audit triggers. */
export async function resetData(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    ALTER TABLE audit_entries DISABLE TRIGGER USER;
    TRUNCATE execution_events, operator_sessions, operator_accounts, jobs, settings, concepts, audit_entries, alerts, delivery_events, suppressions,
      attempts, executions, manifests, batches, receipt_history, receipts RESTART IDENTITY;
    ALTER TABLE audit_entries ENABLE TRIGGER USER;
    INSERT INTO concepts (key, subject, active) VALUES
      ('PAGO ADMINISTRACIÓN', 'Pago administración', true), ('CUOTA EXTRA', 'Cuota extra', true), ('MULTA', 'Multa', true);
    INSERT INTO settings (id) VALUES (1);
  `);
}
