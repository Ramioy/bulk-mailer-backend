import 'reflect-metadata';

import { readFileSync } from 'node:fs';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { MAX_ATTACHMENT_BYTES } from './adapters/outbound/pdf/basic-pdf-inspector';
import { AppModule } from './app.module';
import { type Adapters, buildAdapters } from './composition/adapters';
import type { AppConfig } from './config/app-config';

/** TLS is terminated by the backend itself: with TLS configured, a plain connection fails at the transport. */
function httpAdapter(config: AppConfig): FastifyAdapter {
  if (!config.tls) return new FastifyAdapter();
  return new FastifyAdapter({ https: { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) } });
}

export async function createApp(config: AppConfig, adapters?: Adapters): Promise<NestFastifyApplication> {
  const resolved = adapters ?? (await buildAdapters(config));
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config, resolved), httpAdapter(config), {
    logger: config.nodeEnv === 'test' ? false : ['log', 'warn', 'error'],
  });
  // One byte above the limit is enough to know a file is too large.
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 300, fields: 10 },
  });
  // ZeptoMail posts the event as a single form-encoded parameter; the signature is checked over the raw body.
  // D49: the web client runs on another origin; tokens travel in the Authorization header, never in cookies.
  // A request without Origin (ZeptoMail's webhook, curl) is not a CORS request and is not affected.
  if (config.corsAllowedOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsAllowedOrigins.includes('*') ? true : [...config.corsAllowedOrigins],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
      credentials: false,
      maxAge: 600,
    });
  }
  app.useBodyParser('application/x-www-form-urlencoded', { bodyLimit: 1024 * 1024 }, (_request, body, done) => done(null, body.toString('utf8')));
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().addHook('onClose', async () => resolved.close());
  return app;
}
