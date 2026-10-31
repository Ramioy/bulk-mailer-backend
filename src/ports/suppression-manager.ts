import type { Result } from '../domain/shared/result';

/** Removes an address from the provider's suppression list (first half of the atomic release). */
export interface SuppressionManager {
  release(email: string): Promise<Result<'RELEASED' | 'NOT_SUPPRESSED', string>>;
}
