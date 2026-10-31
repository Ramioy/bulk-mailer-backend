import { randomUUID } from 'node:crypto';

import { LocalJwtAuthenticator } from '../adapters/outbound/auth/local-jwt-authenticator';
import { PostgresOperatorAccountStore } from '../adapters/outbound/auth/postgres-operator-account-store';
import { createDataSource } from '../adapters/outbound/postgres/data-source';
import { PostgresBulkMailerRepository } from '../adapters/outbound/postgres/postgres-bulk-mailer-repository';
import { EnvSecretStore } from '../adapters/outbound/system/env-secret-store';
import { SystemClock } from '../adapters/outbound/system/system-clock';
import type { AppConfig } from '../config/app-config';
import type { Authenticator } from '../ports/authenticator';
import type { BulkMailerRepository } from '../ports/bulk-mailer-repository';
import type { Clock } from '../ports/clock';
import type { SecretStore } from '../ports/secret-store';

/** Every adapter the application uses. Tests build their own set; production uses `buildAdapters`. */
export interface Adapters {
  readonly repository: BulkMailerRepository;
  readonly authenticator: Authenticator;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Releases connections on shutdown. */
  close(): Promise<void>;
}

export const JWT_SIGNING_KEY_SECRET = 'JWT_SIGNING_KEY';

/** Decodes the base64 signing key from the secret store. */
export async function loadSigningKey(secrets: SecretStore): Promise<Buffer> {
  const key = Buffer.from(await secrets.get(JWT_SIGNING_KEY_SECRET), 'base64');
  if (key.length < 32) throw new Error(`${JWT_SIGNING_KEY_SECRET} must decode to at least 32 bytes (base64)`);
  return key;
}

export async function buildAdapters(config: AppConfig, secrets: SecretStore = new EnvSecretStore()): Promise<Adapters> {
  const clock = new SystemClock();
  const dataSource = await createDataSource(config.databaseUrl).initialize();
  const authenticator = new LocalJwtAuthenticator(new PostgresOperatorAccountStore(dataSource), clock, {
    signingKey: await loadSigningKey(secrets),
    accessTokenMinutes: config.accessTokenMinutes,
    sessionHours: config.sessionHours,
  });
  return {
    repository: new PostgresBulkMailerRepository(dataSource),
    authenticator,
    clock,
    newId: randomUUID,
    close: () => dataSource.destroy(),
  };
}
