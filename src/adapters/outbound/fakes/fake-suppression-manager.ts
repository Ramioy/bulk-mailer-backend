import { err, ok, type Result } from '../../../domain/shared/result';
import type { SuppressionManager } from '../../../ports/suppression-manager';

export class FakeSuppressionManager implements SuppressionManager {
  private readonly suppressed = new Set<string>();
  private failure: string | undefined;

  async release(email: string): Promise<Result<'RELEASED' | 'NOT_SUPPRESSED', string>> {
    if (this.failure !== undefined) return err(this.failure);
    return ok(this.suppressed.delete(email) ? 'RELEASED' : 'NOT_SUPPRESSED');
  }

  suppress(email: string): void {
    this.suppressed.add(email);
  }

  isSuppressed(email: string): boolean {
    return this.suppressed.has(email);
  }

  /** Makes every release fail with this message (or succeed again with `undefined`). */
  failWith(message: string | undefined): void {
    this.failure = message;
  }
}
