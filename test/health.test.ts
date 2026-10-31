import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config/app-config';

describe('GET /health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(loadConfig({ NODE_ENV: 'test', DATA_DIR: '/tmp/bulk-mailer-test', DATABASE_URL: 'postgres://unused' }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
