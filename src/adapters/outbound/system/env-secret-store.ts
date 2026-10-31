import { MissingSecretError, type SecretStore } from '../../../ports/secret-store';

/** Reads secrets injected as environment variables by the environment's secrets manager. */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(name: string): Promise<string> {
    const value = this.env[name];
    if (value === undefined || value === '') throw new MissingSecretError(name);
    return value;
  }
}
