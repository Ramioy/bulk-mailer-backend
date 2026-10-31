/** A broken domain invariant: a programming error, never a business outcome. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
