import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { LocalJwtAuthenticator } from '../../src/adapters/outbound/auth/local-jwt-authenticator';
import { InMemoryOperatorAccountStore, type OperatorAccount } from '../../src/adapters/outbound/auth/operator-account-store';
import { hashPassword } from '../../src/adapters/outbound/auth/password-hasher';
import { FakeContractSource } from '../../src/adapters/outbound/fakes/fake-contract-source';
import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { FakeSendLookup } from '../../src/adapters/outbound/fakes/fake-send-lookup';
import { FakeSuppressionManager } from '../../src/adapters/outbound/fakes/fake-suppression-manager';
import type { ZeptoMailWebhookSecrets } from '../../src/adapters/inbound/webhooks/zeptomail-webhook';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { SseProgressHub } from '../../src/adapters/outbound/sse/sse-progress-hub';
import { InProcessEventBus } from '../../src/adapters/outbound/events/in-process-event-bus';
import type { OutboxRelay } from '../../src/application/events/outbox-relay';
import { UiAlertNotifier } from '../../src/adapters/outbound/ui-alert-notifier';
import type { JobLanes } from '../../src/adapters/inbound/jobs/job-runner';
import { JOB_RUNNER, OUTBOX_RELAY } from '../../src/composition/tokens';
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
  readonly lookup: FakeSendLookup;
  readonly suppressionManager: FakeSuppressionManager;
  /** The background runner is not started in tests: call `runner.drain()` to process queued jobs. */
  readonly runner: JobLanes;
  /** Not started in tests either: call `relay.drain()` to deliver outbox events. */
  readonly relay: OutboxRelay;
}

/** Real LocalJwtAuthenticator over in-memory storage, with one operator account `operador`. */
export const WEBHOOK_SECRETS: ZeptoMailWebhookSecrets = {
  authenticationKey: 'webhook-hmac-key',
  authorizationHeader: 'authorization',
  authorizationValue: 'Webhook s3cr3t',
  maxSkewSeconds: 300,
};

export async function startTestApp(env: Record<string, string> = {}, options: { readonly suppressionConfirmation?: 'PROVIDER_API' | 'OPERATOR'; readonly adapters?: Partial<Adapters>; readonly beforeInit?: (app: NestFastifyApplication) => void } = {}): Promise<TestContext> {
  const clock = new FixedClock();
  const repository = new InMemoryBulkMailerRepository();
  const account: OperatorAccount = { operatorId: 'op-1', username: 'operador', passwordHash: await hashPassword(TEST_PASSWORD) };
  const authenticator = new LocalJwtAuthenticator(new InMemoryOperatorAccountStore([account]), clock, {
    signingKey: SIGNING_KEY,
    accessTokenMinutes: 15,
    sessionHours: 8,
  });
  const email = new FakeEmailProvider();
  const lookup = new FakeSendLookup();
  const suppressionManager = new FakeSuppressionManager(options.suppressionConfirmation);
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
    sendLookup: lookup,
    suppressionManager,
    webhookSecrets: WEBHOOK_SECRETS,
    jobQueue: new InMemoryJobQueue(() => clock.now(), () => repository.jobTable()),
    progressHub: new SseProgressHub(),
    eventBus: new InProcessEventBus(),
    alertNotifiers: [new UiAlertNotifier()],
    close: async () => undefined,
    ...options.adapters,
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: '/tmp/bulk-mailer-test',
    DATABASE_URL: 'postgres://unused',
    JOB_RUNNER_ENABLED: 'false',
    ...env,
  });
  const app = await createApp(config, adapters);
  options.beforeInit?.(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, adapters, repository, clock, tayrona, email, lookup, suppressionManager, runner: app.get<JobLanes>(JOB_RUNNER), relay: app.get<OutboxRelay>(OUTBOX_RELAY) };
}
