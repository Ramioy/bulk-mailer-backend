import type { Result } from '../domain/shared/result';

/**
 * Removes an address from the provider's suppression list: the first half of the atomic release (§10.3).
 * `OPERATOR` confirmation: the provider offers no API, so the operator removes the address in the provider
 * console and confirms it; the adapter cannot check it (D19).
 */
export interface SuppressionManager {
  readonly confirmation: 'PROVIDER_API' | 'OPERATOR';
  release(email: string): Promise<Result<'RELEASED' | 'NOT_SUPPRESSED' | 'CONFIRMED_BY_OPERATOR', string>>;
}
