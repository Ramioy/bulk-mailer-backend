import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { LocalJwtAuthenticator } from '../../src/adapters/outbound/auth/local-jwt-authenticator';
import { InMemoryOperatorAccountStore, type OperatorAccount } from '../../src/adapters/outbound/auth/operator-account-store';
import { hashPassword } from '../../src/adapters/outbound/auth/password-hasher';
import { FakeContractSource } from '../../src/adapters/outbound/fakes/fake-contract-source';
import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { SseProgressHub } from '../../src/adapters/outbound/sse/sse-progress-hub';
import { UiAlertNotifier } from '../../src/adapters/outbound/ui-alert-notifier';
import type { JobRunner } from '../../src/adapters/inbound/jobs/job-runner';
import { JOB_RUNNER } from '../../src/composition/tokens';
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
  readonly email: FakeEmailProvider;
  /** The background runner is not started in tests: call `runner.drain()` to process queued jobs. */
  readonly runner: JobRunner;
}

/** Real LocalJwtAuthenticator over in-memory storage, with one operator account `operador`. */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestContext> {
  const clock = new FixedClock();
  const repository = new InMemoryBulkMailerRepository();
  const account: OperatorAccount = { operatorId: 'op-1', username: 'operador', passwordHash: await hashPassword(TEST_PASSWORD) };
  const authenticator = new LocalJwtAuthenticator(new InMemoryOperatorAccountStore([account]), clock, {
    signingKey: SIGNING_KEY,
    accessTokenMinutes: 15,
    sessionHours: 8,
  });
  const email = new FakeEmailProvider();
  const tayrona = new FakeContractSource({ '104522': { complexName: 'Edificio Altos', email: 'admin@altos.com' } });
  const adapters: Adapters = {
    repository,
    authenticator,
    clock,
    newId: randomUUID,
    fileStore: new InMemoryReceiptFileStore(),
    fileInspector: new BasicPdfInspector(),
    contractSources: { TAYRONA: tayrona, SAP: new FakeContractSource() },
    emailProvider: email,
    jobQueue: new InMemoryJobQueue(() => clock.now()),
    progressHub: new SseProgressHub(),
    alertNotifiers: [new UiAlertNotifier()],
    close: async () => undefined,
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: '/tmp/bulk-mailer-test',
    DATABASE_URL: 'postgres://unused',
    JOB_RUNNER_ENABLED: 'false',
    ...env,
  });
  const app = await createApp(config, adapters);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, adapters, repository, clock, tayrona, email, runner: app.get<JobRunner>(JOB_RUNNER) };
}
