import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import type { AppConfig } from './config/app-config';

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config), new FastifyAdapter(), {
    logger: config.nodeEnv === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  return app;
}
