import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AdminController } from './adapters/inbound/http/admin/admin.controller';
import { OutboxController } from './adapters/inbound/http/outbox/outbox.controller';
import { AlertsController } from './adapters/inbound/http/alerts/alerts.controller';
import { InstanceController } from './adapters/inbound/http/instance/instance.controller';
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
import { adminUseCases } from './composition/admin-use-cases';
import { deliveryUseCases } from './composition/delivery-use-cases';
import { executionUseCases } from './composition/execution-use-cases';
import { fileUseCases } from './composition/file-use-cases';
import { fileKeyOf } from './application/files/delete-receipt-file';
import { receiptUseCases } from './composition/receipt-use-cases';
import { ADAPTERS, ADMIN_USE_CASES, AUTH_USE_CASES, AUTHENTICATOR, DELIVERY_USE_CASES, EXECUTION_USE_CASES, FILE_USE_CASES, INSTANCE_ID, JOB_RUNNER, CLOCK, WEBHOOK_SECRETS, OUTBOX_RELAY, RECEIPT_USE_CASES, SSE_HUB } from './composition/tokens';
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
    // D47: which process this is, as shown in the lease and in GET /instance.
    const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const emailTemplate = loadEmailTemplate(config);
    const executions = executionUseCases({
      repository: adapters.repository,
      fileStore: adapters.fileStore,
      contractSources: adapters.contractSources,
      emailProvider: adapters.emailProvider,
      progress: adapters.progressHub,
      clock: adapters.clock,
      newId: adapters.newId,
      serial,
      timeZone: config.timeZone,
      pauseBetweenSendsMs: config.sendPauseMs,
      incidentPolicy: { baseWaitSeconds: config.incidentBaseWaitSeconds, maxWaitSeconds: config.incidentMaxWaitSeconds, stopAfter: 3 },
      archiveCopyAddress: config.archiveCopyAddress,
      emailTemplate,
      abortAfterMinutes: config.executionAbortAfterMinutes,
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
        recentCheckBatchSize: config.deliveryCheckBatchSize,
        recentCheckBackoffCycles: config.deliveryCheckBackoffCycles,
        sweepBatchSize: config.reconcileSweepBatchSize,
      },
      emailTemplate,
      archiveCopyAddress: config.archiveCopyAddress,
    });
    const files = fileUseCases({
      repository: adapters.repository,
      fileStore: adapters.fileStore,
      jobQueue: adapters.jobQueue,
      clock: adapters.clock,
      newId: adapters.newId,
      serial,
      orphanMinAgeMinutes: config.fileOrphanMinAgeMinutes,
      retentionDays: config.workRetentionDays,
    });
    const fileLogger = new Logger('FileLane');
    // Four lanes (D21, D38, D41): one batch at a time in the whole system; webhooks one at a time, never behind a lookup;
    // lookups in the provider logs (reconciliation, sweep, per-minute check) one at a time. Every receipt change of
    // every lane still goes through the same serial executor.
    // On shutdown each lane signals its job and waits for it at most `shutdownTimeoutSeconds` (D33).
    const laneOptions = { stopTimeoutMs: config.shutdownTimeoutSeconds * 1000 };
    const runner = new JobLanes([
      new JobRunner(
        adapters.jobQueue,
        { EXECUTE_BATCH: (job, signal) => executions.run.execute(String(job.payload.executionId), signal) },
        adapters.clock,
        config.jobRunnerPollMs,
        new Logger('ExecutionLane'),
        laneOptions,
      ),
      new JobRunner(
        adapters.jobQueue,
        {
          PROCESS_DELIVERY_EVENT: async (job) => {
            await delivery.processWebhook.execute(String(job.payload.webhookRequestId));
          },
        },
        adapters.clock,
        config.jobRunnerPollMs,
        new Logger('WebhookLane'),
        laneOptions,
      ),
      new JobRunner(
        adapters.jobQueue,
        {
          RECONCILE_ATTEMPT: async (job) => {
            await delivery.reconcile.execute(String(job.payload.attemptId), job.payload.final === true);
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
        new Logger('LookupLane'),
        laneOptions,
      ),
      // D41: deleting receipt files is local I/O: its own small lane, so it never waits for the logs API.
      new JobRunner(
        adapters.jobQueue,
        {
          DELETE_RECEIPT_FILE: async (job) => {
            await files.deleteFile.execute(fileKeyOf(job.payload));
          },
          PURGE_BATCH_FILES: async (job) => {
            await files.purgeBatch.execute(job.payload);
          },
          PURGE_ORPHAN_FILES: async () => {
            const result = await files.purgeOrphans.execute();
            if (result.deleted > 0 || result.failed > 0) fileLogger.log(`Orphan files: ${result.deleted} deleted, ${result.failed} failed, ${result.tooRecent} too recent`);
          },
          PURGE_FINISHED_WORK: async () => {
            const result = await files.purgeFinishedWork.execute();
            fileLogger.log(`Finished work purged: ${result.jobs} job(s), ${result.events} outbox event(s)`);
          },
        },
        adapters.clock,
        config.jobRunnerPollMs,
        fileLogger,
        laneOptions,
      ),
    ]);
    // Consumers of domain events. Registered alert providers receive every raised alert.
    adapters.eventBus.subscribe('ALERT_RAISED', async (event) => {
      const alert = alertFromEvent(event.payload);
      await Promise.all(adapters.alertNotifiers.map((notifier) => notifier.notify(alert)));
    });
    adapters.eventBus.subscribe('RECEIPT_UNCERTAIN', (event) => delivery.followUps.onReceiptUncertain(event));
    adapters.eventBus.subscribe('WEBHOOK_RECEIVED', (event) => delivery.followUps.onWebhookReceived(event));
    const relay = new OutboxRelay(adapters.repository, adapters.eventBus, adapters.clock, { newId: adapters.newId, logger: new Logger('OutboxRelay') });
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, ReceiptsController, ExecutionsController, DeliveryController, WebhooksController, AdminController, OutboxController, AlertsController, InstanceController],
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
        {
          provide: ADMIN_USE_CASES,
          useValue: adminUseCases({
            repository: adapters.repository,
            clock: adapters.clock,
            newId: adapters.newId,
            serial,
            archiveCopyAddress: config.archiveCopyAddress,
            instanceLease: adapters.instanceLease,
            instanceId,
          }),
        },
        { provide: INSTANCE_ID, useValue: instanceId },
        { provide: SSE_HUB, useValue: adapters.progressHub },
        { provide: CLOCK, useValue: adapters.clock },
        { provide: WEBHOOK_SECRETS, useValue: adapters.webhookSecrets },
        { provide: JOB_RUNNER, useValue: runner },
        { provide: FILE_USE_CASES, useValue: files },
        { provide: OUTBOX_RELAY, useValue: relay },
        BackgroundWork,
        { provide: APP_GUARD, useClass: BearerAuthGuard },
      ],
    };
  }
}
