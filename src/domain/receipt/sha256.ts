import { DomainError } from '../shared/domain-error';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Receipt identity: SHA-256 of the file content, lower-case hex. */
export type Sha256 = string & { readonly __brand: 'Sha256' };

export function toSha256(hex: string): Sha256 {
  const value = hex.toLowerCase();
  if (!SHA256_PATTERN.test(value)) throw new DomainError(`Not a SHA-256 hex digest: ${hex}`);
  return value as Sha256;
}
