import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { LocalJwtAuthenticator } from '../../src/adapters/outbound/auth/local-jwt-authenticator';
import { InMemoryOperatorAccountStore, type OperatorAccount } from '../../src/adapters/outbound/auth/operator-account-store';
import { hashPassword } from '../../src/adapters/outbound/auth/password-hasher';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
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
  const adapters: Adapters = { repository, authenticator, clock, newId: randomUUID, close: async () => undefined };
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '/tmp/bulk-mailer-test', DATABASE_URL: 'postgres://unused' });
  const app = await createApp(config, adapters);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, adapters, repository, clock };
}
