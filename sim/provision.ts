/**
 * Simulation: what the deployment team does once per environment (deploy/db/roles.sql), as the database owner,
 * after `db:migrate`: the restricted application role and one operator account.
 *
 * Env: OWNER_DATABASE_URL, APP_DB_PASSWORD, SIM_OPERATOR, SIM_OPERATOR_PASSWORD
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Client } from 'pg';

const require = createRequire(import.meta.url);
const { hashPassword } = require('../dist/adapters/outbound/auth/password-hasher.js') as { hashPassword: (password: string) => Promise<string> };

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const client = new Client({ connectionString: env('OWNER_DATABASE_URL') });
await client.connect();
try {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'bulk_mailer_app'");
  const password = env('APP_DB_PASSWORD').replaceAll("'", "''");
  const roles = readFileSync(new URL('../deploy/db/roles.sql', import.meta.url), 'utf8')
    .replace("CREATE ROLE bulk_mailer_app LOGIN PASSWORD :'app_password';", exists.rowCount ? `ALTER ROLE bulk_mailer_app PASSWORD '${password}';` : `CREATE ROLE bulk_mailer_app LOGIN PASSWORD '${password}';`);
  await client.query(roles);
  await client.query(
    `INSERT INTO operator_accounts (operator_id, username, password_hash) VALUES ('op-sim', $1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [env('SIM_OPERATOR'), await hashPassword(env('SIM_OPERATOR_PASSWORD'))],
  );
  process.stdout.write('Provisioned: role bulk_mailer_app (deploy/db/roles.sql) and the operator account\n');
} finally {
  await client.end();
}
