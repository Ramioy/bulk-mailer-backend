import type { AlertMatch } from '../../domain/alert/alert';
import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import type { ReceiptState } from '../../domain/receipt/receipt-state';
import type { Sha256 } from '../../domain/receipt/sha256';
import type { Attempt } from '../../domain/sending/attempt';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';

type AlertStores = Pick<BulkMailerStores, 'alerts'>;

/**
 * D52: the system marks resolved the alerts whose cause the caller just resolved, in the caller's transaction (so the
 * resolution and its cause commit together). Acknowledging them stays the operator's.
 */
export async function resolveAlerts(tx: AlertStores, matches: readonly AlertMatch[], at: Date, resolution: string): Promise<number> {
  let resolved = 0;
  for (const match of matches) resolved += await tx.alerts.resolve(match, at, resolution);
  return resolved;
}

/** D52: BATCH_STOPPED alerts carry their batch (`period/block`) as reference. */
export const batchReference = (period: Period, block: Block): string => `${period.toString()}/${block}`;

/** D52: a later execution of the batch completed, or the stopped batch settled (D41). */
export function resolveBatchStopped(tx: AlertStores, period: Period, block: Block, at: Date, resolution: string): Promise<number> {
  return tx.alerts.resolve({ type: 'BATCH_STOPPED', reference: batchReference(period, block) }, at, resolution);
}

/**
 * D52: what a change of state of a receipt resolves.
 * - Leaving UNCERTAIN resolves UNCERTAIN_UNRESOLVED (of that attempt, when known).
 * - Reaching SENT through a send resolves the HARD_BOUNCE, COMPLAINT and PROCESS_FAILED of the receipt raised before
 *   that send started: they were about an earlier send, and this one went out.
 */
export async function resolveReceiptAlerts(
  tx: AlertStores,
  at: Date,
  change: {
    readonly sha256: Sha256;
    readonly from: ReceiptState;
    readonly to: ReceiptState;
    readonly attempt?: Pick<Attempt, 'attemptId' | 'startedAt'>;
  },
): Promise<number> {
  const { sha256, from, to, attempt } = change;
  let resolved = 0;
  if (from === 'UNCERTAIN' && to !== 'UNCERTAIN') {
    resolved += await tx.alerts.resolve({ type: 'UNCERTAIN_UNRESOLVED', subject: sha256, ...(attempt ? { reference: attempt.attemptId } : {}) }, at, `receipt ${to}`);
  }
  if (to === 'SENT' && from !== 'SENT' && attempt) {
    const matches = (['HARD_BOUNCE', 'COMPLAINT', 'PROCESS_FAILED'] as const).map((type) => ({ type, subject: sha256, raisedNotAfter: attempt.startedAt }));
    resolved += await resolveAlerts(tx, matches, at, `sent again (attempt ${attempt.attemptId})`);
  }
  return resolved;
}
