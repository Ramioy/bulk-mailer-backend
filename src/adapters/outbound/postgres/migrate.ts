import { loadConfig } from '../../../config/app-config';
import { createDataSource } from './data-source';

/** `pnpm db:migrate`: applies pending migrations and exits. */
async function main(): Promise<void> {
  const dataSource = await createDataSource(loadConfig().databaseUrl).initialize();
  try {
    const applied = await dataSource.runMigrations();
    process.stdout.write(`Applied ${applied.length} migration(s)${applied.map((m) => `\n- ${m.name}`).join('')}\n`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
