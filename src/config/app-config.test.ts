import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './app-config';

const REQUIRED = { DATA_DIR: './data', DATABASE_URL: 'postgres://localhost/bulk_mailer' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      timeZone: 'America/Bogota',
      dataDir: './data',
      databaseUrl: 'postgres://localhost/bulk_mailer',
    });
  });

  it('lists every problem at once', () => {
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: 'staging', PORT: '0', TIME_ZONE: 'Mars/Olympus' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems).toHaveLength(5);
  });
});
