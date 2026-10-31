import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './app-config';

const REQUIRED = { DATA_DIR: './data', DATABASE_URL: 'postgres://localhost/bulk_mailer' };
const PRODUCTION = {
  ...REQUIRED,
  NODE_ENV: 'production',
  TAYRONA_API_URL: 'https://tayrona',
  SAP_API_URL: 'https://sap',
  ZEPTOMAIL_FROM_ADDRESS: 'soportes@anutibara.com',
  CORS_ALLOWED_ORIGINS: 'https://bulk-mailer.anutibara.com',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      timeZone: 'America/Bogota',
      dataDir: './data',
      databaseUrl: 'postgres://localhost/bulk_mailer',
      corsAllowedOrigins: [],
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
      reconcileSweepBatchSize: 50,
      deliveryCheckIntervalSeconds: 60,
      deliveryCheckTailMinutes: 30,
      deliveryCheckBatchSize: 20,
      deliveryCheckBackoffCycles: 2,
      sendPauseMs: 1000,
      sendWaitForDelivery: false,
      deliveryWaitMaxSeconds: 120,
      deliveryWaitLookupSeconds: 30,
      incidentBaseWaitSeconds: 30,
      incidentMaxWaitSeconds: 600,
      fileOrphanSweepIntervalMinutes: 360,
      fileOrphanMinAgeMinutes: 60,
      uploadMaxTotalBytes: 209715200,
      uploadMaxFiles: 300,
      workRetentionDays: 30,
      maxAttachmentBytes: 15728640,
      authRateLimitPerMinute: 20,
      instanceLeaseTtlSeconds: 30,
      jobRunnerEnabled: true,
      jobRunnerPollMs: 1000,
      executionAbortAfterMinutes: 10,
      shutdownTimeoutSeconds: 25,
    });
  });

  it('D48: the upload budget is made of positive integers', () => {
    expect(loadConfig({ ...REQUIRED, UPLOAD_MAX_TOTAL_BYTES: '1000', UPLOAD_MAX_FILES: '3' })).toMatchObject({ uploadMaxTotalBytes: 1000, uploadMaxFiles: 3 });
    expect(() => loadConfig({ ...REQUIRED, UPLOAD_MAX_TOTAL_BYTES: '0' })).toThrow('UPLOAD_MAX_TOTAL_BYTES must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, UPLOAD_MAX_FILES: '-3' })).toThrow('UPLOAD_MAX_FILES must be a positive integer');
  });

  it('D50: work retention and the attachment limit are positive integers', () => {
    expect(loadConfig({ ...REQUIRED, WORK_RETENTION_DAYS: '7', MAX_ATTACHMENT_BYTES: '1000' })).toMatchObject({ workRetentionDays: 7, maxAttachmentBytes: 1000 });
    expect(() => loadConfig({ ...REQUIRED, WORK_RETENTION_DAYS: '0' })).toThrow('WORK_RETENTION_DAYS must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, MAX_ATTACHMENT_BYTES: 'x' })).toThrow('MAX_ATTACHMENT_BYTES must be a positive integer');
  });

  it('D47: the instance lease TTL is an integer of at least 3 seconds', () => {
    expect(loadConfig({ ...REQUIRED, INSTANCE_LEASE_TTL_SECONDS: '9' })).toMatchObject({ instanceLeaseTtlSeconds: 9 });
    expect(() => loadConfig({ ...REQUIRED, INSTANCE_LEASE_TTL_SECONDS: '2' })).toThrow('INSTANCE_LEASE_TTL_SECONDS must be at least 3');
    expect(() => loadConfig({ ...REQUIRED, INSTANCE_LEASE_TTL_SECONDS: 'x' })).toThrow('INSTANCE_LEASE_TTL_SECONDS must be a positive integer');
  });

  it('D49: CORS origins are exact origins, required in production and never * there', () => {
    expect(loadConfig({ ...REQUIRED, CORS_ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:5173' }).corsAllowedOrigins).toEqual(['https://a.example.com', 'http://localhost:5173']);
    expect(loadConfig({ ...REQUIRED, CORS_ALLOWED_ORIGINS: '*' }).corsAllowedOrigins).toEqual(['*']);
    const { CORS_ALLOWED_ORIGINS: _cors, ...withoutCors } = PRODUCTION;
    expect(() => loadConfig({ ...withoutCors, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k' })).toThrow('CORS_ALLOWED_ORIGINS is required in production');
    expect(() => loadConfig({ ...PRODUCTION, TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k', CORS_ALLOWED_ORIGINS: '*' })).toThrow('CORS_ALLOWED_ORIGINS cannot be * in production');
    for (const bad of ['https://a.example.com/', 'https://a.example.com/app', 'ftp://a.example.com', 'a.example.com']) {
      expect(() => loadConfig({ ...REQUIRED, CORS_ALLOWED_ORIGINS: bad })).toThrow('is not an origin');
    }
  });

  it('D44: the sweep budget is a positive integer', () => {
    expect(loadConfig({ ...REQUIRED, RECONCILE_SWEEP_BATCH_SIZE: '10' })).toMatchObject({ reconcileSweepBatchSize: 10 });
    expect(() => loadConfig({ ...REQUIRED, RECONCILE_SWEEP_BATCH_SIZE: '0' })).toThrow('RECONCILE_SWEEP_BATCH_SIZE must be a positive integer');
  });

  it('D41: the orphan sweep interval and minimum age are positive integers', () => {
    expect(loadConfig({ ...REQUIRED, FILE_ORPHAN_SWEEP_INTERVAL_MINUTES: '30', FILE_ORPHAN_MIN_AGE_MINUTES: '5' })).toMatchObject({ fileOrphanSweepIntervalMinutes: 30, fileOrphanMinAgeMinutes: 5 });
    expect(() => loadConfig({ ...REQUIRED, FILE_ORPHAN_SWEEP_INTERVAL_MINUTES: '0' })).toThrow('FILE_ORPHAN_SWEEP_INTERVAL_MINUTES must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, FILE_ORPHAN_MIN_AGE_MINUTES: 'x' })).toThrow('FILE_ORPHAN_MIN_AGE_MINUTES must be a positive integer');
  });

  it('D38: the per-minute check budget is a positive integer and the backoff an integer >= 0', () => {
    expect(loadConfig({ ...REQUIRED, DELIVERY_CHECK_BATCH_SIZE: '5', DELIVERY_CHECK_BACKOFF_CYCLES: '0' })).toMatchObject({ deliveryCheckBatchSize: 5, deliveryCheckBackoffCycles: 0 });
    expect(() => loadConfig({ ...REQUIRED, DELIVERY_CHECK_BATCH_SIZE: '0' })).toThrow('DELIVERY_CHECK_BATCH_SIZE must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, DELIVERY_CHECK_BACKOFF_CYCLES: '-1' })).toThrow('DELIVERY_CHECK_BACKOFF_CYCLES must be an integer >= 0');
  });

  it('D32/D33: the abort threshold and the shutdown timeout are positive integers', () => {
    expect(loadConfig({ ...REQUIRED, EXECUTION_ABORT_AFTER_MINUTES: '3', SHUTDOWN_TIMEOUT_SECONDS: '40' })).toMatchObject({
      executionAbortAfterMinutes: 3,
      shutdownTimeoutSeconds: 40,
    });
    expect(() => loadConfig({ ...REQUIRED, EXECUTION_ABORT_AFTER_MINUTES: '0' })).toThrow('EXECUTION_ABORT_AFTER_MINUTES must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, EXECUTION_ABORT_AFTER_MINUTES: '2.5' })).toThrow('EXECUTION_ABORT_AFTER_MINUTES must be a positive integer');
    expect(() => loadConfig({ ...REQUIRED, SHUTDOWN_TIMEOUT_SECONDS: '-1' })).toThrow('SHUTDOWN_TIMEOUT_SECONDS must be a positive integer');
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
