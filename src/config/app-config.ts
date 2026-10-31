export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  /** IANA time zone used to compute the current period. */
  readonly timeZone: string;
  /** Root of the volume where receipts are kept until their batch is processed. */
  readonly dataDir: string;
  readonly databaseUrl: string;
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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    host: env.HOST ?? '0.0.0.0',
    port,
    timeZone,
    dataDir,
    databaseUrl,
  };
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
