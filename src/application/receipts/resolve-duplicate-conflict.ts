import { ConceptCatalog } from '../../domain/concept/concept';
import { inConflict, type Receipt } from '../../domain/receipt/receipt';
import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import { parseReceiptFileName, type ReceiptFileName } from '../../domain/receipt/receipt-file-name';
import type { Sha256 } from '../../domain/receipt/sha256';
import type { FileErrorType } from '../../domain/shared/error-types';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import { retireFile } from '../files/retire-file';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import { lookupRecipient, publishNextManifest, refuseBatchCommand, withSuppression, type BatchCommandError, type ReceiptDependencies } from './receipt-dependencies';

export type ResolveConflictError =
  | { readonly code: BatchCommandError | 'RECEIPT_NOT_FOUND' | 'RECEIPT_NOT_IN_CONFLICT' | 'NOTE_REQUIRED' | 'NAME_NOT_IN_CONFLICT' }
  /** The chosen name is no longer valid (e.g. its concept was retired since the upload). */
  | { readonly code: 'CHOSEN_NAME_INVALID'; readonly reason: FileErrorType };

export interface ResolvedConflict {
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly period: string;
  readonly block: string;
  readonly state: Receipt['state'];
  readonly errorType?: Receipt['errorType'];
  readonly email?: string;
}

/**
 * D31: the operator chooses which of the names the content arrived under is the right one. The receipt takes that
 * name, contract and concept (and its batch, moving there if it is another one, as in D8), its recipient is looked up
 * again, and it can be sent. Audited, with a mandatory note. Removing the receipt is the other way out.
 * In two phases (D36): the checks and the contract lookup outside the serial executor; inside it, in one transaction,
 * every check again on the current receipt, the suppression list and both batches, then the writes.
 */
export class ResolveDuplicateConflict {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(operator: string, sha256: Sha256, rawFileName: string, rawNote: string): Promise<Result<ResolvedConflict, ResolveConflictError>> {
    const { repository, fileStore, clock, newId } = this.deps;
    const note = rawNote.trim();
    if (note === '') return err({ code: 'NOTE_REQUIRED' });
    const fileName = rawFileName.normalize('NFC');

    // Phase (a).
    const before = await this.check(repository, sha256, fileName);
    if (!before.ok) return before;
    const lookup = await lookupRecipient(this.deps, before.value.chosen.block, before.value.contract);

    // Phase (b).
    return this.deps.serial.run(async () => {
      const outcome = await repository.transaction(async (tx): Promise<Result<{ resolved: Receipt }, ResolveConflictError>> => {
        const checked = await this.check(tx, sha256, fileName);
        if (!checked.ok) return checked;
        const { receipt, chosen, parsed } = checked.value;
        // The contract comes from the chosen name: the same name cannot give another one.
        const resolution = await withSuppression(tx, lookup);
        const now = clock.now();
        const moved = !(chosen.period.equals(receipt.period) && chosen.block === receipt.block);
        const resolved: Receipt = {
          ...receipt,
          period: chosen.period,
          block: chosen.block,
          fileName,
          conceptKey: parsed.concept.key,
          contract: parsed.contract,
          recipient: resolution.recipient,
          // A FAILED receipt keeps its send error visible unless a recipient error replaces it.
          errorType: resolution.errorType ?? (receipt.state === 'FAILED' && receipt.errorType !== 'DUPLICATE_CONFLICT' ? receipt.errorType : undefined),
          conflictingNames: undefined,
          updatedAt: now,
        };
        // The volume is local (not an external service): the file is in place before the row that points to it.
        if (moved) {
          const content = await fileStore.read({ period: receipt.period, block: receipt.block, sha256 });
          if (content) await fileStore.save({ period: chosen.period, block: chosen.block, sha256 }, content);
        }
        const names = [receipt.fileName, ...(receipt.conflictingNames ?? []).map((n) => n.fileName)].join(' | ');
        await tx.receipts.save(resolved);
        // D50: the copy left in the old batch is deleted by a job queued here (D41), not after the commit.
        if (moved) await retireFile(tx, { period: receipt.period, block: receipt.block, sha256, fileAvailable: true }, now);
        await tx.receipts.appendHistory({ sha256, at: now, event: 'DUPLICATE_CONFLICT_RESOLVED', detail: `${fileName}${moved ? ` (moved from ${receipt.period.toString()}/${receipt.block})` : ''}` });
        // Both batch rows are read inside this transaction by publishNextManifest.
        if (moved) await publishNextManifest(tx, receipt.period, receipt.block, now);
        const published = await publishNextManifest(tx, chosen.period, chosen.block, now);
        await tx.audit.append({
          auditId: newId(),
          actor: operator,
          action: 'DUPLICATE_CONFLICT_RESOLVED',
          at: now,
          subject: sha256,
          previousValue: names,
          newValue: `${fileName} (${chosen.period.toString()}/${chosen.block})`,
          note,
        });
        await tx.outbox.add(
          domainEvent(newId, 'DUPLICATE_CONFLICT_RESOLVED', now, {
            sha256,
            fileName,
            period: chosen.period.toString(),
            block: chosen.block,
            manifestVersion: published.version,
            by: operator,
          }),
        );
        return ok({ resolved });
      });
      if (!outcome.ok) return outcome;
      const { resolved } = outcome.value;
      return ok({
        sha256,
        fileName,
        period: resolved.period.toString(),
        block: resolved.block,
        state: resolved.state,
        errorType: resolved.errorType,
        email: resolved.recipient?.email,
      });
    });
  }

  /** The checks of the command, on the given stores: outside first, then again inside the transaction. */
  private async check(stores: BulkMailerStores, sha256: Sha256, fileName: string): Promise<Result<Checked, ResolveConflictError>> {
    const receipt = await stores.receipts.get(sha256);
    if (!receipt) return err({ code: 'RECEIPT_NOT_FOUND' });
    if (!inConflict(receipt) || (receipt.state !== 'PENDING' && receipt.state !== 'FAILED')) return err({ code: 'RECEIPT_NOT_IN_CONFLICT' });
    const candidates = [{ fileName: receipt.fileName, period: receipt.period, block: receipt.block }, ...(receipt.conflictingNames ?? [])];
    const chosen = candidates.find((c) => c.fileName === fileName);
    if (!chosen) return err({ code: 'NAME_NOT_IN_CONFLICT' });
    for (const p of new Set([receipt.period, chosen.period])) {
      const refusal = await refuseBatchCommand(this.deps, p, stores);
      if (refusal) return err({ code: refusal });
    }
    const parsed = parseReceiptFileName(fileName, new ConceptCatalog(await stores.concepts.list()), this.deps.fileNameOptions);
    if (!parsed.ok) return err({ code: 'CHOSEN_NAME_INVALID', reason: parsed.error });
    return ok({ receipt, chosen: { period: chosen.period, block: chosen.block }, parsed: parsed.value, contract: parsed.value.contract });
  }
}

interface Checked {
  readonly receipt: Receipt;
  readonly chosen: { readonly period: Period; readonly block: Block };
  readonly parsed: ReceiptFileName;
  readonly contract: string;
}
