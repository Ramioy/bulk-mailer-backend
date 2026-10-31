import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './adapters/inbound/http/auth/auth.controller';
import { BearerAuthGuard } from './adapters/inbound/http/auth/bearer-auth.guard';
import { DeliveryController } from './adapters/inbound/http/delivery/delivery.controller';
import { ExecutionsController } from './adapters/inbound/http/executions/executions.controller';
import { WebhooksController } from './adapters/inbound/http/webhooks/webhooks.controller';
import { HealthController } from './adapters/inbound/http/health.controller';
import { BackgroundWork } from './adapters/inbound/jobs/background-work';
import { JobLanes, JobRunner } from './adapters/inbound/jobs/job-runner';
import { ReceiptsController } from './adapters/inbound/http/receipts/receipts.controller';
import { alertFromEvent } from './application/alerts/raise-alert';
import { AuthUseCases } from './application/auth/auth-use-cases';
import { OutboxRelay } from './application/events/outbox-relay';
import { SerialExecutor } from './application/shared/serial-executor';
import { type Adapters, loadEmailTemplate } from './composition/adapters';
import { deliveryUseCases } from './composition/delivery-use-cases';
import { executionUseCases } from './composition/execution-use-cases';
import { receiptUseCases } from './composition/receipt-use-cases';
import { ADAPTERS, AUTH_USE_CASES, AUTHENTICATOR, DELIVERY_USE_CASES, EXECUTION_USE_CASES, JOB_RUNNER, OUTBOX_RELAY, RECEIPT_USE_CASES, SSE_HUB } from './composition/tokens';
import { APP_CONFIG, type AppConfig } from './config/app-config';

/**
 * Composition root: the only place where ports are bound to adapters and use cases are built.
 * The adapters are chosen outside (production: `buildAdapters`; tests: in-memory and fakes).
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, adapters: Adapters): DynamicModule {
    // One executor for every command that changes a batch (and, in step 6, starts an execution).
    const serial = new SerialExecutor();
    const emailTemplate = loadEmailTemplate(config);
    const executions = executionUseCases({
      repository: adapters.repository,
      fileStore: adapters.fileStore,
      contractSources: adapters.contractSources,
      emailProvider: adapters.emailProvider,
      jobQueue: adapters.jobQueue,
      progress: adapters.progressHub,
      clock: adapters.clock,
      newId: adapters.newId,
      serial,
      timeZone: config.timeZone,
      pauseBetweenSendsMs: config.sendPauseMs,
      incidentPolicy: { baseWaitSeconds: config.incidentBaseWaitSeconds, maxWaitSeconds: config.incidentMaxWaitSeconds, stopAfter: 3 },
      archiveCopyAddress: config.archiveCopyAddress,
      emailTemplate,
    });
    const delivery = deliveryUseCases({
      repository: adapters.repository,
      jobQueue: adapters.jobQueue,
      sendLookup: adapters.sendLookup,
      suppressionManager: adapters.suppressionManager,
      fileStore: adapters.fileStore,
      contractSources: adapters.contractSources,
      emailProvider: adapters.emailProvider,
      clock: adapters.clock,
      newId: adapters.newId,
      serial,
      reconciliation: {
        uncertainDelaysMinutes: config.reconcileDelaysMinutes,
        sweepAfterHours: config.reconcileSweepAfterHours,
        sweepMaxHours: config.reconcileSweepMaxHours,
        recentCheckTailMinutes: config.deliveryCheckTailMinutes,
      },
      emailTemplate,
      archiveCopyAddress: config.archiveCopyAddress,
    });
    // Two lanes (D21): one batch at a time in the whole system; delivery work one at a time, in parallel to it.
    const runner = new JobLanes([
      new JobRunner(
        adapters.jobQueue,
        { EXECUTE_BATCH: (job) => executions.run.execute(String(job.payload.executionId)) },
        adapters.clock,
        config.jobRunnerPollMs,
        new Logger('ExecutionLane'),
      ),
      new JobRunner(
        adapters.jobQueue,
        {
          RECONCILE_ATTEMPT: async (job) => {
            await delivery.reconcile.execute(String(job.payload.attemptId), job.payload.final === true);
          },
          PROCESS_DELIVERY_EVENT: async (job) => {
            await delivery.processWebhook.execute(String(job.payload.webhookRequestId));
          },
          SWEEP_UNCONFIRMED: async () => {
            await delivery.sweep.execute();
          },
          CHECK_RECENT_SENDS: async () => {
            await delivery.recentSends.execute();
          },
        },
        adapters.clock,
        config.jobRunnerPollMs,
        new Logger('DeliveryLane'),
      ),
    ]);
    // Consumers of domain events. Registered alert providers receive every raised alert.
    adapters.eventBus.subscribe('ALERT_RAISED', async (event) => {
      const alert = alertFromEvent(event.payload);
      await Promise.all(adapters.alertNotifiers.map((notifier) => notifier.notify(alert)));
    });
    adapters.eventBus.subscribe('RECEIPT_UNCERTAIN', (event) => delivery.followUps.onReceiptUncertain(event));
    adapters.eventBus.subscribe('WEBHOOK_RECEIVED', (event) => delivery.followUps.onWebhookReceived(event));
    const relay = new OutboxRelay(adapters.repository, adapters.eventBus, adapters.clock);
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, ReceiptsController, ExecutionsController, DeliveryController, WebhooksController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ADAPTERS, useValue: adapters },
        { provide: AUTHENTICATOR, useValue: adapters.authenticator },
        {
          provide: AUTH_USE_CASES,
          useValue: new AuthUseCases({
            authenticator: adapters.authenticator,
            audit: adapters.repository.audit,
            clock: adapters.clock,
            newId: adapters.newId,
          }),
        },
        {
          provide: RECEIPT_USE_CASES,
          useValue: receiptUseCases({
            repository: adapters.repository,
            fileStore: adapters.fileStore,
            inspector: adapters.fileInspector,
            contractSources: adapters.contractSources,
            clock: adapters.clock,
            newId: adapters.newId,
            serial,
            timeZone: config.timeZone,
            fileNameOptions: { allowLeadingZeros: config.contractAllowLeadingZeros },
          }),
        },
        { provide: EXECUTION_USE_CASES, useValue: executions },
        { provide: DELIVERY_USE_CASES, useValue: delivery },
        { provide: SSE_HUB, useValue: adapters.progressHub },
        { provide: JOB_RUNNER, useValue: runner },
        { provide: OUTBOX_RELAY, useValue: relay },
        BackgroundWork,
        { provide: APP_GUARD, useClass: BearerAuthGuard },
      ],
    };
  }
}
