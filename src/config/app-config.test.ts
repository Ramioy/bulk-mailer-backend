import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './app-config';

const REQUIRED = { DATA_DIR: './data', DATABASE_URL: 'postgres://localhost/bulk_mailer' };
const PRODUCTION = { ...REQUIRED, NODE_ENV: 'production', TAYRONA_API_URL: 'https://tayrona', SAP_API_URL: 'https://sap', ZEPTOMAIL_FROM_ADDRESS: 'soportes@anutibara.com' };

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
      contractSource: 'fake',
      contractApiTimeoutMs: 5000,
      emailProvider: 'fake',
      webhookAuthHeader: 'authorization',
      webhookMaxSkewSeconds: 300,
      reconcileDelaysMinutes: [5, 15, 60],
      reconcileSweepAfterHours: 6,
      reconcileSweepMaxHours: 72,
      reconcileSweepIntervalMinutes: 60,
      deliveryCheckIntervalSeconds: 60,
      deliveryCheckTailMinutes: 30,
      sendPauseMs: 1000,
      incidentBaseWaitSeconds: 30,
      incidentMaxWaitSeconds: 600,
      jobRunnerEnabled: true,
      jobRunnerPollMs: 1000,
      executionAbortAfterMinutes: 10,
    });
  });

  it('D32: the abort threshold is a positive integer', () => {
    expect(loadConfig({ ...REQUIRED, EXECUTION_ABORT_AFTER_MINUTES: '3' })).toMatchObject({ executionAbortAfterMinutes: 3 });
    expect(() => loadConfig({ ...REQUIRED, EXECUTION_ABORT_AFTER_MINUTES: '0' })).toThrow('EXECUTION_ABORT_AFTER_MINUTES must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, EXECUTION_ABORT_AFTER_MINUTES: '2.5' })).toThrow('EXECUTION_ABORT_AFTER_MINUTES must be a positive integer');
  });

  it('requires TLS in production, with both files', () => {
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: 'production' })).toThrow('required in production');
    expect(() => loadConfig({ ...REQUIRED, TLS_CERT_FILE: 'cert.pem' })).toThrow('go together');
    expect(loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k' }).tls).toEqual({ certFile: 'c', keyFile: 'k' });
  });

  it('uses ZeptoMail in production and requires the test mailbox redirect to use it anywhere else', () => {
    expect(loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k' })).toMatchObject({
      emailProvider: 'zeptomail',
      zeptomail: { baseUrl: 'https://cpaas.zoho.com/v1.1', fromAddress: 'soportes@anutibara.com', timeoutMs: 30000, accountsUrl: 'https://accounts.zoho.com' },
    });
    expect(loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k' }).redirectAllEmailTo).toBeUndefined();
    expect(() => loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k', EMAIL_PROVIDER: 'fake' })).toThrow('EMAIL_PROVIDER=fake is not allowed');
    expect(() => loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k', NONPROD_REDIRECT_TO: 'x@y.co' })).toThrow('not allowed in production');
    const zepto = { ...REQUIRED, EMAIL_PROVIDER: 'zeptomail', ZEPTOMAIL_FROM_ADDRESS: 'soportes@anutibara.com' };
    expect(() => loadConfig(zepto)).toThrow('NONPROD_REDIRECT_TO');
    expect(loadConfig({ ...zepto, NONPROD_REDIRECT_TO: 'pruebas@anutibara.com' }).redirectAllEmailTo).toBe('pruebas@anutibara.com');
  });

  it('uses the HTTP contracts APIs in production and refuses simulated sources there', () => {
    expect(loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k' })).toMatchObject({ contractSource: 'http', tayronaApiUrl: 'https://tayrona' });
    expect(() => loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k', CONTRACT_SOURCE: 'fake' })).toThrow('not allowed in production');
    expect(() => loadConfig({ ...REQUIRED, CONTRACT_SOURCE: 'http' })).toThrow('TAYRONA_API_URL and SAP_API_URL are required');
  });

  it('validates the reconciliation schedule and the webhook header', () => {
    expect(loadConfig({ ...REQUIRED, RECONCILE_DELAYS_MINUTES: '10, 30', ZEPTOMAIL_WEBHOOK_AUTH_HEADER: 'X-Bulk-Mailer' })).toMatchObject({
      reconcileDelaysMinutes: [10, 30],
      webhookAuthHeader: 'x-bulk-mailer',
    });
    expect(() => loadConfig({ ...REQUIRED, RECONCILE_DELAYS_MINUTES: '15,5' })).toThrow('RECONCILE_DELAYS_MINUTES');
    expect(() => loadConfig({ ...REQUIRED, RECONCILE_SWEEP_AFTER_HOURS: '80' })).toThrow('RECONCILE_SWEEP_MAX_HOURS');
    expect(() => loadConfig({ ...REQUIRED, ZEPTOMAIL_WEBHOOK_AUTH_HEADER: 'bad header' })).toThrow('ZEPTOMAIL_WEBHOOK_AUTH_HEADER');
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
