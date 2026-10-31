export class MissingSecretError extends Error {
  constructor(readonly secretName: string) {
    super(`Secret "${secretName}" is not configured`);
    this.name = 'MissingSecretError';
  }
}

export interface SecretStore {
  /** Throws MissingSecretError when the secret does not exist. */
  get(name: string): Promise<string>;
}
