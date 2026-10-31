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
      accessTokenMinutes: 15,
      sessionHours: 8,
      pdfMaxIncrementalUpdates: 0,
      contractAllowLeadingZeros: false,
      sendPauseMs: 1000,
      incidentBaseWaitSeconds: 30,
      incidentMaxWaitSeconds: 600,
      jobRunnerEnabled: true,
      jobRunnerPollMs: 1000,
    });
  });

  it('requires TLS in production, with both files', () => {
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: 'production' })).toThrow('required in production');
    expect(() => loadConfig({ ...REQUIRED, TLS_CERT_FILE: 'cert.pem' })).toThrow('go together');
    expect(loadConfig({ ...REQUIRED, NODE_ENV: 'production', TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k' }).tls).toEqual({ certFile: 'c', keyFile: 'k' });
  });

  it('lists every problem at once', () => {
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: 'staging', PORT: '0', TIME_ZONE: 'Mars/Olympus', SESSION_HOURS: '0' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems).toHaveLength(6);
  });
});
