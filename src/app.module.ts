import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './adapters/inbound/http/auth/auth.controller';
import { BearerAuthGuard } from './adapters/inbound/http/auth/bearer-auth.guard';
import { HealthController } from './adapters/inbound/http/health.controller';
import { ReceiptsController } from './adapters/inbound/http/receipts/receipts.controller';
import { AuthUseCases } from './application/auth/auth-use-cases';
import { SerialExecutor } from './application/shared/serial-executor';
import type { Adapters } from './composition/adapters';
import { receiptUseCases } from './composition/receipt-use-cases';
import { ADAPTERS, AUTH_USE_CASES, AUTHENTICATOR, RECEIPT_USE_CASES } from './composition/tokens';
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
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, ReceiptsController],
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
        { provide: APP_GUARD, useClass: BearerAuthGuard },
      ],
    };
  }
}
