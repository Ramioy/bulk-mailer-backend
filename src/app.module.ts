import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './adapters/inbound/http/auth/auth.controller';
import { BearerAuthGuard } from './adapters/inbound/http/auth/bearer-auth.guard';
import { HealthController } from './adapters/inbound/http/health.controller';
import { AuthUseCases } from './application/auth/auth-use-cases';
import type { Adapters } from './composition/adapters';
import { ADAPTERS, AUTH_USE_CASES, AUTHENTICATOR } from './composition/tokens';
import { APP_CONFIG, type AppConfig } from './config/app-config';

/**
 * Composition root: the only place where ports are bound to adapters and use cases are built.
 * The adapters are chosen outside (production: `buildAdapters`; tests: in-memory and fakes).
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, adapters: Adapters): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController],
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
        { provide: APP_GUARD, useClass: BearerAuthGuard },
      ],
    };
  }
}
