import { ConceptCatalog } from '../../domain/concept/concept';
import { inConflict, type Receipt } from '../../domain/receipt/receipt';
import { parseReceiptFileName } from '../../domain/receipt/receipt-file-name';
import type { Sha256 } from '../../domain/receipt/sha256';
import type { FileErrorType } from '../../domain/shared/error-types';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import { publishNextManifest, refuseBatchCommand, resolveRecipientFor, type BatchCommandError, type ReceiptDependencies } from './receipt-dependencies';

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
 */
export class ResolveDuplicateConflict {
  constructor(private readonly deps: ReceiptDependencies) {}

  execute(operator: string, sha256: Sha256, rawFileName: string, rawNote: string): Promise<Result<ResolvedConflict, ResolveConflictError>> {
    return this.deps.serial.run(async () => {
      const { repository, fileStore, clock, newId } = this.deps;
      const note = rawNote.trim();
      if (note === '') return err({ code: 'NOTE_REQUIRED' });
      const receipt = await repository.receipts.get(sha256);
      if (!receipt) return err({ code: 'RECEIPT_NOT_FOUND' });
      if (!inConflict(receipt) || (receipt.state !== 'PENDING' && receipt.state !== 'FAILED')) return err({ code: 'RECEIPT_NOT_IN_CONFLICT' });

      const fileName = rawFileName.normalize('NFC');
      const candidates = [{ fileName: receipt.fileName, period: receipt.period, block: receipt.block }, ...(receipt.conflictingNames ?? [])];
      const chosen = candidates.find((c) => c.fileName === fileName);
      if (!chosen) return err({ code: 'NAME_NOT_IN_CONFLICT' });
      for (const p of new Set([receipt.period, chosen.period])) {
        const refusal = await refuseBatchCommand(this.deps, p);
        if (refusal) return err({ code: refusal });
      }
      const parsed = parseReceiptFileName(fileName, new ConceptCatalog(await repository.concepts.list()), this.deps.fileNameOptions);
      if (!parsed.ok) return err({ code: 'CHOSEN_NAME_INVALID', reason: parsed.error });

      const resolution = await resolveRecipientFor(this.deps, chosen.block, parsed.value.contract);
      const now = clock.now();
      const moved = !(chosen.period.equals(receipt.period) && chosen.block === receipt.block);
      const resolved: Receipt = {
        ...receipt,
        period: chosen.period,
        block: chosen.block,
        fileName,
        conceptKey: parsed.value.concept.key,
        contract: parsed.value.contract,
        recipient: resolution.recipient,
        // A FAILED receipt keeps its send error visible unless a recipient error replaces it.
        errorType: resolution.errorType ?? (receipt.state === 'FAILED' && receipt.errorType !== 'DUPLICATE_CONFLICT' ? receipt.errorType : undefined),
        conflictingNames: undefined,
        updatedAt: now,
      };
      if (moved) {
        const content = await fileStore.read({ period: receipt.period, block: receipt.block, sha256 });
        if (content) await fileStore.save({ period: chosen.period, block: chosen.block, sha256 }, content);
      }

      const names = candidates.map((c) => c.fileName).join(' | ');
      await repository.transaction(async (tx) => {
        await tx.receipts.save(resolved);
        await tx.receipts.appendHistory({ sha256, at: now, event: 'DUPLICATE_CONFLICT_RESOLVED', detail: `${fileName}${moved ? ` (moved from ${receipt.period.toString()}/${receipt.block})` : ''}` });
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
      });
      if (moved) await fileStore.delete({ period: receipt.period, block: receipt.block, sha256 });
      return ok({
        sha256,
        fileName,
        period: chosen.period.toString(),
        block: chosen.block,
        state: resolved.state,
        errorType: resolved.errorType,
        email: resolved.recipient?.email,
      });
    });
  }
}
