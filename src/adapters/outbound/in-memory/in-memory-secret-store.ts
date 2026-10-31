import { MissingSecretError, type SecretStore } from '../../../ports/secret-store';

export class InMemorySecretStore implements SecretStore {
  constructor(private readonly secrets: Readonly<Record<string, string>> = {}) {}

  async get(name: string): Promise<string> {
    const value = this.secrets[name];
    if (value === undefined) throw new MissingSecretError(name);
    return value;
  }
}
