export interface TlsConfig {
  readonly certFile: string;
  readonly keyFile: string;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  /** IANA time zone used to compute the current period. */
  readonly timeZone: string;
  /** Root of the volume where receipts are kept until their batch is processed. */
  readonly dataDir: string;
  readonly databaseUrl: string;
  /** Required in production. */
  readonly tls?: TlsConfig;
  /**
   * D49: exact origins of the web client allowed by CORS (`https://host[:port]`). Required in production, never `*`
   * there; empty elsewhere means CORS is off (same-origin only).
   */
  readonly corsAllowedOrigins: readonly string[];
  readonly accessTokenMinutes: number;
  /** Absolute lifetime of a session (refresh credential). */
  readonly sessionHours: number;
  /** Incremental PDF revisions accepted (control 6); default 0, calibrated in the pilot. */
  readonly pdfMaxIncrementalUpdates: number;
  /** Accept and strip leading zeros in the contract of the file name; default false. */
  readonly contractAllowLeadingZeros: boolean;
  /** `http` (Tayrona and SAP APIs) or `fake` (non-production only). */
  readonly contractSource: 'http' | 'fake';
  readonly tayronaApiUrl?: string;
  readonly sapApiUrl?: string;
  /** Maximum wait of the contracts APIs; default 5 s. */
  readonly contractApiTimeoutMs: number;
  /** Non-production only: data for the simulated contract sources. */
  readonly fakeContractsFile?: string;
  /** `zeptomail` or `fake` (non-production only). */
  readonly emailProvider: 'zeptomail' | 'fake';
  readonly zeptomail?: {
    readonly baseUrl: string;
    readonly fromAddress: string;
    readonly fromName?: string;
    readonly bounceAddress?: string;
    readonly timeoutMs: number;
    /** Zoho Accounts of the account's data centre, for the OAuth token of the logs API. */
    readonly accountsUrl: string;
  };
  /** Name of the custom authorization header configured on the ZeptoMail webhook; default `authorization`. */
  readonly webhookAuthHeader: string;
  /** Maximum distance between the webhook signature timestamp and now; default 300 s. */
  readonly webhookMaxSkewSeconds: number;
  /** Lookups of an UNCERTAIN send, minutes after it; default 5,15,60 (§9.4). */
  readonly reconcileDelaysMinutes: readonly number[];
  /** SENT receipts without delivery events are looked up from N hours (default 6) up to 72 hours. */
  readonly reconcileSweepAfterHours: number;
  readonly reconcileSweepMaxHours: number;
  /** How often the sweep runs; default 60 minutes. */
  readonly reconcileSweepIntervalMinutes: number;
  /** Lookups per hourly sweep, oldest sends first (D44); default 50. */
  readonly reconcileSweepBatchSize: number;
  /** While a batch runs and `deliveryCheckTailMinutes` after, its sends are checked this often; default 60 s (D21). */
  readonly deliveryCheckIntervalSeconds: number;
  readonly deliveryCheckTailMinutes: number;
  /** Sends looked up per per-minute check (D38); default 20. */
  readonly deliveryCheckBatchSize: number;
  /** Checks skipped by a send whose lookup found the logs API unavailable (D38); default 2. */
  readonly deliveryCheckBackoffCycles: number;
  /** Outside production every email goes to this test mailbox (§15). Required with ZeptoMail outside production. */
  readonly redirectAllEmailTo?: string;
  /** Pause between two sends; default 1000 ms. */
  readonly sendPauseMs: number;
  /** Growing wait after uncertain responses: base (30 s) and ceiling for Retry-After (600 s). */
  readonly incidentBaseWaitSeconds: number;
  readonly incidentMaxWaitSeconds: number;
  /** Archive copy (bcc) address; needed only while the copy setting is enabled. */
  readonly archiveCopyAddress?: string;
  /** JSON file `{ "subject": "…", "body": "…" }` replacing the default email template. */
  readonly emailTemplateFile?: string;
  /** How often the orphan file sweep runs (D41); default 360 minutes. */
  readonly fileOrphanSweepIntervalMinutes: number;
  /** The sweep leaves alone files younger than this (D41); default 60 minutes. */
  readonly fileOrphanMinAgeMinutes: number;
  readonly jobRunnerEnabled: boolean;
  readonly jobRunnerPollMs: number;
  /** The operator may abort a running execution after this many minutes without progress, or by forcing it; default 10 (D32). */
  readonly executionAbortAfterMinutes: number;
  /** On shutdown, how long the job lanes may take to finish the job in progress; default 25 s (D33). */
  readonly shutdownTimeoutSeconds: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const NODE_ENVS = ['development', 'test', 'production'] as const;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Reads and validates the configuration once, at startup. Fails fast listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!isNodeEnv(nodeEnv)) problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be an integer between 1 and 65535');

  const timeZone = env.TIME_ZONE ?? 'America/Bogota';
  if (!isValidTimeZone(timeZone)) problems.push(`TIME_ZONE "${timeZone}" is not a valid IANA time zone`);

  const dataDir = env.DATA_DIR ?? '';
  if (dataDir === '') problems.push('DATA_DIR is required');

  const databaseUrl = env.DATABASE_URL ?? '';
  if (databaseUrl === '') problems.push('DATABASE_URL is required');

  const certFile = env.TLS_CERT_FILE ?? '';
  const keyFile = env.TLS_KEY_FILE ?? '';
  if ((certFile === '') !== (keyFile === '')) problems.push('TLS_CERT_FILE and TLS_KEY_FILE go together');
  if (nodeEnv === 'production' && certFile === '') problems.push('TLS_CERT_FILE and TLS_KEY_FILE are required in production');

  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  if (nodeEnv === 'production' && corsAllowedOrigins.length === 0) problems.push('CORS_ALLOWED_ORIGINS is required in production');
  if (nodeEnv === 'production' && corsAllowedOrigins.includes('*')) problems.push('CORS_ALLOWED_ORIGINS cannot be * in production');
  for (const origin of corsAllowedOrigins) {
    if (origin !== '*' && !isOrigin(origin)) problems.push(`CORS_ALLOWED_ORIGINS: "${origin}" is not an origin (http(s)://host[:port], no path, no trailing slash)`);
  }
  const accessTokenMinutes = positiveInteger(env.ACCESS_TOKEN_MINUTES ?? '15', 'ACCESS_TOKEN_MINUTES', problems);
  const sessionHours = positiveInteger(env.SESSION_HOURS ?? '8', 'SESSION_HOURS', problems);
  const pdfMaxIncrementalUpdates = Number(env.PDF_MAX_INCREMENTAL_UPDATES ?? '0');
  if (!Number.isInteger(pdfMaxIncrementalUpdates) || pdfMaxIncrementalUpdates < 0) {
    problems.push('PDF_MAX_INCREMENTAL_UPDATES must be an integer >= 0');
  }
  const leadingZeros = env.CONTRACT_ALLOW_LEADING_ZEROS ?? 'false';
  if (leadingZeros !== 'true' && leadingZeros !== 'false') problems.push('CONTRACT_ALLOW_LEADING_ZEROS must be true or false');
  const fakeContractsFile = env.FAKE_CONTRACTS_FILE ?? '';
  if (nodeEnv === 'production' && fakeContractsFile !== '') problems.push('FAKE_CONTRACTS_FILE is not allowed in production');
  const contractSource = env.CONTRACT_SOURCE ?? (nodeEnv === 'production' ? 'http' : 'fake');
  if (contractSource !== 'http' && contractSource !== 'fake') problems.push('CONTRACT_SOURCE must be http or fake');
  if (nodeEnv === 'production' && contractSource === 'fake') problems.push('CONTRACT_SOURCE=fake is not allowed in production');
  const tayronaApiUrl = env.TAYRONA_API_URL ?? '';
  const sapApiUrl = env.SAP_API_URL ?? '';
  if (contractSource === 'http' && (tayronaApiUrl === '' || sapApiUrl === '')) problems.push('TAYRONA_API_URL and SAP_API_URL are required with CONTRACT_SOURCE=http');
  const contractApiTimeoutMs = positiveInteger(env.CONTRACT_API_TIMEOUT_MS ?? '5000', 'CONTRACT_API_TIMEOUT_MS', problems);
  const emailProvider = env.EMAIL_PROVIDER ?? (nodeEnv === 'production' ? 'zeptomail' : 'fake');
  if (emailProvider !== 'zeptomail' && emailProvider !== 'fake') problems.push('EMAIL_PROVIDER must be zeptomail or fake');
  if (nodeEnv === 'production' && emailProvider === 'fake') problems.push('EMAIL_PROVIDER=fake is not allowed in production');
  const fromAddress = env.ZEPTOMAIL_FROM_ADDRESS ?? '';
  if (emailProvider === 'zeptomail' && !isEmail(fromAddress)) problems.push('ZEPTOMAIL_FROM_ADDRESS (a valid email) is required with EMAIL_PROVIDER=zeptomail');
  const bounceAddress = env.ZEPTOMAIL_BOUNCE_ADDRESS ?? '';
  if (bounceAddress !== '' && !isEmail(bounceAddress)) problems.push('ZEPTOMAIL_BOUNCE_ADDRESS is not a valid email');
  const zeptomailTimeoutMs = positiveInteger(env.ZEPTOMAIL_TIMEOUT_MS ?? '30000', 'ZEPTOMAIL_TIMEOUT_MS', problems);
  const redirect = env.NONPROD_REDIRECT_TO ?? '';
  if (nodeEnv === 'production' && redirect !== '') problems.push('NONPROD_REDIRECT_TO is not allowed in production');
  if (nodeEnv !== 'production' && emailProvider === 'zeptomail' && !isEmail(redirect)) {
    problems.push('NONPROD_REDIRECT_TO (a valid email) is required to use ZeptoMail outside production');
  }
  const webhookAuthHeader = (env.ZEPTOMAIL_WEBHOOK_AUTH_HEADER ?? 'authorization').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(webhookAuthHeader)) problems.push('ZEPTOMAIL_WEBHOOK_AUTH_HEADER must be an HTTP header name');
  const webhookMaxSkewSeconds = positiveInteger(env.WEBHOOK_MAX_SKEW_SECONDS ?? '300', 'WEBHOOK_MAX_SKEW_SECONDS', problems);
  const reconcileDelaysMinutes = (env.RECONCILE_DELAYS_MINUTES ?? '5,15,60').split(',').map((d) => Number(d.trim()));
  if (reconcileDelaysMinutes.some((d) => !Number.isInteger(d) || d < 1) || reconcileDelaysMinutes.some((d, i) => i > 0 && d <= (reconcileDelaysMinutes[i - 1] ?? 0))) {
    problems.push('RECONCILE_DELAYS_MINUTES must be increasing positive integers, e.g. 5,15,60');
  }
  const reconcileSweepAfterHours = positiveInteger(env.RECONCILE_SWEEP_AFTER_HOURS ?? '6', 'RECONCILE_SWEEP_AFTER_HOURS', problems);
  const reconcileSweepMaxHours = positiveInteger(env.RECONCILE_SWEEP_MAX_HOURS ?? '72', 'RECONCILE_SWEEP_MAX_HOURS', problems);
  if (reconcileSweepMaxHours <= reconcileSweepAfterHours) problems.push('RECONCILE_SWEEP_MAX_HOURS must be greater than RECONCILE_SWEEP_AFTER_HOURS');
  const reconcileSweepIntervalMinutes = positiveInteger(env.RECONCILE_SWEEP_INTERVAL_MINUTES ?? '60', 'RECONCILE_SWEEP_INTERVAL_MINUTES', problems);
  const reconcileSweepBatchSize = positiveInteger(env.RECONCILE_SWEEP_BATCH_SIZE ?? '50', 'RECONCILE_SWEEP_BATCH_SIZE', problems);
  const deliveryCheckIntervalSeconds = positiveInteger(env.DELIVERY_CHECK_INTERVAL_SECONDS ?? '60', 'DELIVERY_CHECK_INTERVAL_SECONDS', problems);
  const deliveryCheckTailMinutes = nonNegativeInteger(env.DELIVERY_CHECK_TAIL_MINUTES ?? '30', 'DELIVERY_CHECK_TAIL_MINUTES', problems);
  const deliveryCheckBatchSize = positiveInteger(env.DELIVERY_CHECK_BATCH_SIZE ?? '20', 'DELIVERY_CHECK_BATCH_SIZE', problems);
  const deliveryCheckBackoffCycles = nonNegativeInteger(env.DELIVERY_CHECK_BACKOFF_CYCLES ?? '2', 'DELIVERY_CHECK_BACKOFF_CYCLES', problems);
  const sendPauseMs = nonNegativeInteger(env.SEND_PAUSE_MS ?? '1000', 'SEND_PAUSE_MS', problems);
  const incidentBaseWaitSeconds = positiveInteger(env.INCIDENT_BASE_WAIT_SECONDS ?? '30', 'INCIDENT_BASE_WAIT_SECONDS', problems);
  const incidentMaxWaitSeconds = positiveInteger(env.INCIDENT_MAX_WAIT_SECONDS ?? '600', 'INCIDENT_MAX_WAIT_SECONDS', problems);
  const archiveCopyAddress = env.ARCHIVE_COPY_ADDRESS ?? '';
  if (archiveCopyAddress !== '' && !isEmail(archiveCopyAddress)) problems.push('ARCHIVE_COPY_ADDRESS is not a valid email');
  const emailTemplateFile = env.EMAIL_TEMPLATE_FILE ?? '';
  const runner = env.JOB_RUNNER_ENABLED ?? 'true';
  if (runner !== 'true' && runner !== 'false') problems.push('JOB_RUNNER_ENABLED must be true or false');
  const jobRunnerPollMs = positiveInteger(env.JOB_RUNNER_POLL_MS ?? '1000', 'JOB_RUNNER_POLL_MS', problems);
  const fileOrphanSweepIntervalMinutes = positiveInteger(env.FILE_ORPHAN_SWEEP_INTERVAL_MINUTES ?? '360', 'FILE_ORPHAN_SWEEP_INTERVAL_MINUTES', problems);
  const fileOrphanMinAgeMinutes = positiveInteger(env.FILE_ORPHAN_MIN_AGE_MINUTES ?? '60', 'FILE_ORPHAN_MIN_AGE_MINUTES', problems);
  const executionAbortAfterMinutes = positiveInteger(env.EXECUTION_ABORT_AFTER_MINUTES ?? '10', 'EXECUTION_ABORT_AFTER_MINUTES', problems);
  const shutdownTimeoutSeconds = positiveInteger(env.SHUTDOWN_TIMEOUT_SECONDS ?? '25', 'SHUTDOWN_TIMEOUT_SECONDS', problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    host: env.HOST ?? '0.0.0.0',
    port,
    timeZone,
    dataDir,
    databaseUrl,
    ...(certFile === '' ? {} : { tls: { certFile, keyFile } }),
    corsAllowedOrigins,
    accessTokenMinutes,
    sessionHours,
    pdfMaxIncrementalUpdates,
    contractAllowLeadingZeros: leadingZeros === 'true',
    contractSource: contractSource as AppConfig['contractSource'],
    ...(tayronaApiUrl === '' ? {} : { tayronaApiUrl }),
    ...(sapApiUrl === '' ? {} : { sapApiUrl }),
    contractApiTimeoutMs,
    ...(fakeContractsFile === '' ? {} : { fakeContractsFile }),
    emailProvider: emailProvider as AppConfig['emailProvider'],
    ...(emailProvider === 'zeptomail'
      ? {
          zeptomail: {
            baseUrl: env.ZEPTOMAIL_BASE_URL ?? 'https://cpaas.zoho.com/v1.1',
            fromAddress,
            ...(env.ZEPTOMAIL_FROM_NAME ? { fromName: env.ZEPTOMAIL_FROM_NAME } : {}),
            ...(bounceAddress === '' ? {} : { bounceAddress }),
            timeoutMs: zeptomailTimeoutMs,
            accountsUrl: env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.com',
          },
        }
      : {}),
    ...(redirect === '' ? {} : { redirectAllEmailTo: redirect }),
    webhookAuthHeader,
    webhookMaxSkewSeconds,
    reconcileDelaysMinutes,
    reconcileSweepAfterHours,
    reconcileSweepMaxHours,
    reconcileSweepIntervalMinutes,
    reconcileSweepBatchSize,
    deliveryCheckIntervalSeconds,
    deliveryCheckTailMinutes,
    deliveryCheckBatchSize,
    deliveryCheckBackoffCycles,
    sendPauseMs,
    incidentBaseWaitSeconds,
    incidentMaxWaitSeconds,
    ...(archiveCopyAddress === '' ? {} : { archiveCopyAddress }),
    ...(emailTemplateFile === '' ? {} : { emailTemplateFile }),
    fileOrphanSweepIntervalMinutes,
    fileOrphanMinAgeMinutes,
    jobRunnerEnabled: runner === 'true',
    jobRunnerPollMs,
    executionAbortAfterMinutes,
    shutdownTimeoutSeconds,
  };
}

function positiveInteger(text: string, name: string, problems: string[]): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) problems.push(`${name} must be a positive integer`);
  return value;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

function nonNegativeInteger(text: string, name: string, problems: string[]): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) problems.push(`${name} must be an integer >= 0`);
  return value;
}

/** `http(s)://host[:port]` exactly as a browser sends it in `Origin`. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

function isNodeEnv(value: string): value is AppConfig['nodeEnv'] {
  return (NODE_ENVS as readonly string[]).includes(value);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}
