import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './adapters/inbound/http/auth/auth.controller';
import { BearerAuthGuard } from './adapters/inbound/http/auth/bearer-auth.guard';
import { ExecutionsController } from './adapters/inbound/http/executions/executions.controller';
import { HealthController } from './adapters/inbound/http/health.controller';
import { BackgroundWork } from './adapters/inbound/jobs/background-work';
import { JobRunner } from './adapters/inbound/jobs/job-runner';
import { ReceiptsController } from './adapters/inbound/http/receipts/receipts.controller';
import { AuthUseCases } from './application/auth/auth-use-cases';
import { SerialExecutor } from './application/shared/serial-executor';
import type { Adapters } from './composition/adapters';
import { executionUseCases } from './composition/execution-use-cases';
import { receiptUseCases } from './composition/receipt-use-cases';
import { ADAPTERS, AUTH_USE_CASES, AUTHENTICATOR, EXECUTION_USE_CASES, JOB_RUNNER, RECEIPT_USE_CASES, SSE_HUB } from './composition/tokens';
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
    const executions = executionUseCases({
      repository: adapters.repository,
      fileStore: adapters.fileStore,
      contractSources: adapters.contractSources,
      emailProvider: adapters.emailProvider,
      jobQueue: adapters.jobQueue,
      progress: adapters.progressHub,
      alertNotifiers: adapters.alertNotifiers,
      clock: adapters.clock,
      newId: adapters.newId,
      serial,
      timeZone: config.timeZone,
      pauseBetweenSendsMs: config.sendPauseMs,
      incidentPolicy: { baseWaitSeconds: config.incidentBaseWaitSeconds, maxWaitSeconds: config.incidentMaxWaitSeconds, stopAfter: 3 },
      archiveCopyAddress: config.archiveCopyAddress,
    });
    const runner = new JobRunner(
      adapters.jobQueue,
      { EXECUTE_BATCH: (job) => executions.run.execute(String(job.payload.executionId)) },
      adapters.clock,
      config.jobRunnerPollMs,
      new Logger('JobRunner'),
    );
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, ReceiptsController, ExecutionsController],
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
        { provide: SSE_HUB, useValue: adapters.progressHub },
        { provide: JOB_RUNNER, useValue: runner },
        BackgroundWork,
        { provide: APP_GUARD, useClass: BearerAuthGuard },
      ],
    };
  }
}
