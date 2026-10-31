import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { FakeContractSource, type FakeContract } from '../adapters/outbound/fakes/fake-contract-source';
import { BasicPdfInspector } from '../adapters/outbound/pdf/basic-pdf-inspector';
import { LocalVolumeFileStore } from '../adapters/outbound/volume/local-volume-file-store';
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
import type { ContractSources } from '../ports/contract-source';
import type { FileInspector } from '../ports/file-inspector';
import type { ReceiptFileStore } from '../ports/receipt-file-store';
import type { SecretStore } from '../ports/secret-store';

/** Every adapter the application uses. Tests build their own set; production uses `buildAdapters`. */
export interface Adapters {
  readonly repository: BulkMailerRepository;
  readonly authenticator: Authenticator;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly fileStore: ReceiptFileStore;
  readonly fileInspector: FileInspector;
  readonly contractSources: ContractSources;
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

/**
 * Simulated contract sources, only outside production, optionally loaded from a JSON file
 * `{ "TAYRONA": { "<contract>": { complexName, email, active? } }, "SAP": { … } }`.
 * The real Tayrona and SAP adapters arrive in steps 7 and 10.
 */
function contractSources(config: AppConfig): ContractSources {
  if (config.nodeEnv === 'production') {
    throw new Error('The Tayrona and SAP contract adapters are not available yet (implementation plan, steps 7 and 10)');
  }
  const data = config.fakeContractsFile
    ? (JSON.parse(readFileSync(config.fakeContractsFile, 'utf8')) as Partial<Record<'TAYRONA' | 'SAP', Record<string, FakeContract>>>)
    : {};
  return { TAYRONA: new FakeContractSource(data.TAYRONA ?? {}), SAP: new FakeContractSource(data.SAP ?? {}) };
}

export async function buildAdapters(config: AppConfig, secrets: SecretStore = new EnvSecretStore()): Promise<Adapters> {
  const sources = contractSources(config);
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
    fileStore: new LocalVolumeFileStore(config.dataDir),
    fileInspector: new BasicPdfInspector({ maxIncrementalUpdates: config.pdfMaxIncrementalUpdates }),
    contractSources: sources,
    close: () => dataSource.destroy(),
  };
}
