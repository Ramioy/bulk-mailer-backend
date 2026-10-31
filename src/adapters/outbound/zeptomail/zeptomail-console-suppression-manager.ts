import { ok, type Result } from '../../../domain/shared/result';
import type { SuppressionManager } from '../../../ports/suppression-manager';

/**
 * ZeptoMail documents no suppression API: the address is removed in the console (Suppression list page) by the
 * operator, who confirms it when releasing it in Bulk Mailer (D19). Nothing to call; the release is audited with
 * that confirmation. Replace with an API adapter if Zoho confirms one (§12.7).
 */
export class ZeptoMailConsoleSuppressionManager implements SuppressionManager {
  readonly confirmation = 'OPERATOR' as const;

  async release(_email: string): Promise<Result<'CONFIRMED_BY_OPERATOR', string>> {
    return ok('CONFIRMED_BY_OPERATOR');
  }
}
