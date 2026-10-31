import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { LocalJwtAuthenticator } from '../../src/adapters/outbound/auth/local-jwt-authenticator';
import { InMemoryOperatorAccountStore, type OperatorAccount } from '../../src/adapters/outbound/auth/operator-account-store';
import { hashPassword } from '../../src/adapters/outbound/auth/password-hasher';
import { FakeContractSource } from '../../src/adapters/outbound/fakes/fake-contract-source';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryReceiptFileStore } from '../../src/adapters/outbound/in-memory/in-memory-receipt-file-store';
import { BasicPdfInspector } from '../../src/adapters/outbound/pdf/basic-pdf-inspector';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { createApp } from '../../src/bootstrap';
import type { Adapters } from '../../src/composition/adapters';
import { loadConfig } from '../../src/config/app-config';

export const TEST_PASSWORD = 'correct horse battery staple';
export const SIGNING_KEY = Buffer.alloc(32, 7);

export interface TestContext {
  readonly app: NestFastifyApplication;
  readonly adapters: Adapters;
  readonly repository: InMemoryBulkMailerRepository;
  readonly clock: FixedClock;
  readonly tayrona: FakeContractSource;
}

/** Real LocalJwtAuthenticator over in-memory storage, with one operator account `operador`. */
export async function startTestApp(): Promise<TestContext> {
  const clock = new FixedClock();
  const repository = new InMemoryBulkMailerRepository();
  const account: OperatorAccount = { operatorId: 'op-1', username: 'operador', passwordHash: await hashPassword(TEST_PASSWORD) };
  const authenticator = new LocalJwtAuthenticator(new InMemoryOperatorAccountStore([account]), clock, {
    signingKey: SIGNING_KEY,
    accessTokenMinutes: 15,
    sessionHours: 8,
  });
  const tayrona = new FakeContractSource({ '104522': { complexName: 'Edificio Altos', email: 'admin@altos.com' } });
  const adapters: Adapters = {
    repository,
    authenticator,
    clock,
    newId: randomUUID,
    fileStore: new InMemoryReceiptFileStore(),
    fileInspector: new BasicPdfInspector(),
    contractSources: { TAYRONA: tayrona, SAP: new FakeContractSource() },
    close: async () => undefined,
  };
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '/tmp/bulk-mailer-test', DATABASE_URL: 'postgres://unused' });
  const app = await createApp(config, adapters);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, adapters, repository, clock, tayrona };
}
