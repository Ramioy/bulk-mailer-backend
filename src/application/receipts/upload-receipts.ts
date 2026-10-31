import { createHash } from 'node:crypto';

import type { Block } from '../../domain/block/block';
import { ConceptCatalog } from '../../domain/concept/concept';
import type { Period } from '../../domain/period/period';
import type { Receipt } from '../../domain/receipt/receipt';
import { parseReceiptFileName } from '../../domain/receipt/receipt-file-name';
import { assertTransition, type ReceiptState } from '../../domain/receipt/receipt-state';
import { toSha256, type Sha256 } from '../../domain/receipt/sha256';
import { decideUpload } from '../../domain/receipt/upload-rule';
import { err, ok, type Result } from '../../domain/shared/result';
import type { FileErrorType, ReceiptErrorType } from '../../domain/shared/error-types';
import { domainEvent } from '../events/domain-events';
import {
  cachedResolver,
  publishNextManifest,
  refuseBatchCommand,
  type BatchCommandError,
  type ReceiptDependencies,
  type RecipientResolution,
} from './receipt-dependencies';

export interface UploadedFile {
  readonly name: string;
  readonly content: Uint8Array;
  /** The transport stopped reading at the size limit; the content is incomplete. */
  readonly tooLarge?: boolean;
}

export type UploadOutcome =
  /** Registered or re-evaluated; see `state` and `errorType`. */
  | 'REGISTERED'
  /** Same content already registered: not stored, not counted. */
  | 'DUPLICATE'
  /** Not registered at all (too large, or a re-upload of a FAILED receipt whose name or file is invalid). */
  | 'REJECTED';

export interface UploadResult {
  readonly fileName: string;
  readonly outcome: UploadOutcome;
  readonly sha256?: Sha256;
  readonly state?: ReceiptState;
  readonly errorType?: ReceiptErrorType;
  readonly errorDetail?: string;
  readonly duplicateOf?: { readonly period: string; readonly block: Block; readonly state: ReceiptState };
}

export interface UploadSummary {
  readonly manifestVersion: number;
  readonly results: readonly UploadResult[];
}

interface Evaluated {
  readonly file: UploadedFile;
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly conceptKey?: string;
  readonly contract?: string;
  readonly fileError?: FileErrorType;
  readonly errorDetail?: string;
  readonly recipient?: RecipientResolution;
}

const sha256Of = (content: Uint8Array) => toSha256(createHash('sha256').update(content).digest('hex'));

export class UploadReceipts {
  constructor(private readonly deps: ReceiptDependencies) {}

  execute(operator: string, period: Period, block: Block, files: readonly UploadedFile[]): Promise<Result<UploadSummary, BatchCommandError>> {
    return this.deps.serial.run(() => this.run(operator, period, block, files));
  }

  private async run(operator: string, period: Period, block: Block, files: readonly UploadedFile[]): Promise<Result<UploadSummary, BatchCommandError>> {
    const refusal = await refuseBatchCommand(this.deps, period);
    if (refusal) return err(refusal);

    const { repository, fileStore, clock } = this.deps;
    const catalog = new ConceptCatalog(await repository.concepts.list());
    const resolve = cachedResolver(this.deps, block);
    const now = clock.now();

    const results: UploadResult[] = [];
    const changed: Receipt[] = [];
    const history: Array<{ sha256: Sha256; event: string; detail?: string }> = [];
    const seen = new Map<Sha256, Receipt>();

    for (const file of files) {
      if (file.tooLarge) {
        results.push({ fileName: file.name.normalize('NFC'), outcome: 'REJECTED', errorType: 'ATTACHMENT_TOO_LARGE' });
        continue;
      }
      const evaluated = await this.evaluate(file, catalog, resolve);
      const existing = seen.get(evaluated.sha256) ?? (await repository.receipts.get(evaluated.sha256));
      const decision = decideUpload(existing, period, block);

      if (decision === 'DUPLICATE' && existing) {
        results.push({
          fileName: evaluated.fileName,
          outcome: 'DUPLICATE',
          sha256: evaluated.sha256,
          duplicateOf: { period: existing.period.toString(), block: existing.block, state: existing.state },
        });
        continue;
      }

      if (decision === 'RESTORE_FILE' && existing) {
        // A bounced SENT receipt gets its file back for Resend (A2); its state and name do not change.
        if (evaluated.fileError) {
          results.push({ fileName: evaluated.fileName, outcome: 'REJECTED', sha256: evaluated.sha256, errorType: evaluated.fileError, errorDetail: evaluated.errorDetail });
          continue;
        }
        const receipt: Receipt = { ...existing, fileAvailable: true, updatedAt: now };
        await fileStore.save({ period, block, sha256: receipt.sha256 }, file.content);
        this.track(receipt, 'FILE_UPLOADED_FOR_RESEND', undefined, changed, history, seen, results);
        continue;
      }

      if (existing?.state === 'FAILED') {
        // A FAILED receipt whose file was purged gets its file back; it stays FAILED until the next execution.
        if (evaluated.fileError) {
          results.push({ fileName: evaluated.fileName, outcome: 'REJECTED', sha256: evaluated.sha256, errorType: evaluated.fileError, errorDetail: evaluated.errorDetail });
          continue;
        }
        const receipt: Receipt = {
          ...existing,
          fileName: evaluated.fileName,
          conceptKey: evaluated.conceptKey,
          contract: evaluated.contract,
          sizeBytes: file.content.length,
          recipient: evaluated.recipient?.recipient,
          errorType: evaluated.recipient?.errorType ?? existing.errorType,
          fileAvailable: true,
          updatedAt: now,
        };
        await fileStore.save({ period, block, sha256: receipt.sha256 }, file.content);
        this.track(receipt, 'FILE_UPLOADED_AGAIN', undefined, changed, history, seen, results);
        continue;
      }

      const state: ReceiptState = evaluated.fileError ? 'INVALID' : 'PENDING';
      if (existing) assertTransition(existing.state, state);
      const receipt: Receipt = {
        sha256: evaluated.sha256,
        period,
        block,
        state,
        fileName: evaluated.fileName,
        conceptKey: evaluated.conceptKey,
        contract: evaluated.contract,
        sizeBytes: file.content.length,
        errorType: evaluated.fileError ?? evaluated.recipient?.errorType,
        errorDetail: evaluated.errorDetail,
        recipient: evaluated.recipient?.recipient,
        // Invalid files are not kept: correcting them means uploading again.
        fileAvailable: state === 'PENDING',
        attempts: existing?.attempts ?? 0,
        deliveryState: existing?.deliveryState,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (receipt.fileAvailable) await fileStore.save({ period, block, sha256: receipt.sha256 }, file.content);
      const event = decision === 'NEW' ? 'UPLOADED' : decision === 'MOVE' ? 'MOVED' : 'UPLOADED_AGAIN';
      const detail = decision === 'MOVE' && existing ? `from ${existing.period.toString()}/${existing.block}` : undefined;
      this.track(receipt, event, detail, changed, history, seen, results);
    }

    if (changed.length === 0) {
      const batch = await repository.batches.get(period, block);
      return ok({ manifestVersion: batch?.manifestVersion ?? 0, results });
    }

    const manifest = await repository.transaction(async (tx) => {
      for (const receipt of changed) await tx.receipts.save(receipt);
      for (const entry of history) await tx.receipts.appendHistory({ ...entry, at: now });
      const published = await publishNextManifest(tx, period, block, now);
      await tx.audit.append({
        auditId: this.deps.newId(),
        actor: operator,
        action: 'RECEIPTS_UPLOADED',
        at: now,
        subject: `${period.toString()}/${block}`,
        newValue: `manifest v${published.version}`,
        note: `${changed.length} registered, ${results.length - changed.length} not registered`,
      });
      await tx.outbox.add(
        domainEvent(this.deps.newId, 'RECEIPTS_UPLOADED', now, {
          period: period.toString(),
          block,
          manifestVersion: published.version,
          registered: changed.map((r) => r.sha256),
        }),
      );
      return published;
    });
    return ok({ manifestVersion: manifest.version, results });
  }

  private async evaluate(file: UploadedFile, catalog: ConceptCatalog, resolve: (contract: string) => Promise<RecipientResolution>): Promise<Evaluated> {
    const sha256 = sha256Of(file.content);
    const name = parseReceiptFileName(file.name, catalog, this.deps.fileNameOptions);
    const fileName = name.ok ? name.value.name : file.name.normalize('NFC');
    const parsed = name.ok ? { conceptKey: name.value.concept.key, contract: name.value.contract } : {};
    if (!name.ok) return { file, sha256, fileName, fileError: name.error };

    const verdict = await this.deps.inspector.inspect(file.content);
    if (!verdict.ok) return { file, sha256, fileName, ...parsed, fileError: verdict.error, errorDetail: verdict.detail };

    return { file, sha256, fileName, ...parsed, recipient: await resolve(name.value.contract) };
  }

  private track(
    receipt: Receipt,
    event: string,
    detail: string | undefined,
    changed: Receipt[],
    history: Array<{ sha256: Sha256; event: string; detail?: string }>,
    seen: Map<Sha256, Receipt>,
    results: UploadResult[],
  ): void {
    changed.push(receipt);
    history.push({ sha256: receipt.sha256, event, detail });
    seen.set(receipt.sha256, receipt);
    results.push({
      fileName: receipt.fileName,
      outcome: 'REGISTERED',
      sha256: receipt.sha256,
      state: receipt.state,
      errorType: receipt.errorType,
      errorDetail: receipt.errorDetail,
    });
  }
}
