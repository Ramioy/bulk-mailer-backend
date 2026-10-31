import { type DynamicModule, Module } from '@nestjs/common';

import { HealthController } from './adapters/inbound/http/health.controller';
import { APP_CONFIG, type AppConfig } from './config/app-config';

/**
 * Composition root: the only place where ports are bound to adapters.
 * Each later step registers its adapters here, chosen by configuration.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
