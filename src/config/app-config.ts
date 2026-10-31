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
  readonly accessTokenMinutes: number;
  /** Absolute lifetime of a session (refresh credential). */
  readonly sessionHours: number;
  /** Incremental PDF revisions accepted (control 6); default 0, calibrated in the pilot. */
  readonly pdfMaxIncrementalUpdates: number;
  /** Accept and strip leading zeros in the contract of the file name; default false. */
  readonly contractAllowLeadingZeros: boolean;
  /** Non-production only: data for the simulated contract sources. */
  readonly fakeContractsFile?: string;
  /** Pause between two sends; default 1000 ms. */
  readonly sendPauseMs: number;
  /** Growing wait after uncertain responses: base (30 s) and ceiling for Retry-After (600 s). */
  readonly incidentBaseWaitSeconds: number;
  readonly incidentMaxWaitSeconds: number;
  /** Archive copy (bcc) address; needed only while the copy setting is enabled. */
  readonly archiveCopyAddress?: string;
  /** JSON file `{ "subject": "…", "body": "…" }` replacing the default email template. */
  readonly emailTemplateFile?: string;
  readonly jobRunnerEnabled: boolean;
  readonly jobRunnerPollMs: number;
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
  const sendPauseMs = nonNegativeInteger(env.SEND_PAUSE_MS ?? '1000', 'SEND_PAUSE_MS', problems);
  const incidentBaseWaitSeconds = positiveInteger(env.INCIDENT_BASE_WAIT_SECONDS ?? '30', 'INCIDENT_BASE_WAIT_SECONDS', problems);
  const incidentMaxWaitSeconds = positiveInteger(env.INCIDENT_MAX_WAIT_SECONDS ?? '600', 'INCIDENT_MAX_WAIT_SECONDS', problems);
  const archiveCopyAddress = env.ARCHIVE_COPY_ADDRESS ?? '';
  if (archiveCopyAddress !== '' && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(archiveCopyAddress)) problems.push('ARCHIVE_COPY_ADDRESS is not a valid email');
  const emailTemplateFile = env.EMAIL_TEMPLATE_FILE ?? '';
  const runner = env.JOB_RUNNER_ENABLED ?? 'true';
  if (runner !== 'true' && runner !== 'false') problems.push('JOB_RUNNER_ENABLED must be true or false');
  const jobRunnerPollMs = positiveInteger(env.JOB_RUNNER_POLL_MS ?? '1000', 'JOB_RUNNER_POLL_MS', problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    host: env.HOST ?? '0.0.0.0',
    port,
    timeZone,
    dataDir,
    databaseUrl,
    ...(certFile === '' ? {} : { tls: { certFile, keyFile } }),
    accessTokenMinutes,
    sessionHours,
    pdfMaxIncrementalUpdates,
    contractAllowLeadingZeros: leadingZeros === 'true',
    ...(fakeContractsFile === '' ? {} : { fakeContractsFile }),
    sendPauseMs,
    incidentBaseWaitSeconds,
    incidentMaxWaitSeconds,
    ...(archiveCopyAddress === '' ? {} : { archiveCopyAddress }),
    ...(emailTemplateFile === '' ? {} : { emailTemplateFile }),
    jobRunnerEnabled: runner === 'true',
    jobRunnerPollMs,
  };
}

function positiveInteger(text: string, name: string, problems: string[]): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) problems.push(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(text: string, name: string, problems: string[]): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) problems.push(`${name} must be an integer >= 0`);
  return value;
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
