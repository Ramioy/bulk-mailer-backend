import { createHash } from 'node:crypto';

import type { Block } from '../../domain/block/block';
import { ConceptCatalog } from '../../domain/concept/concept';
import type { Period } from '../../domain/period/period';
import type { Alert } from '../../domain/alert/alert';
import { inConflict, type ConflictingName, type Receipt } from '../../domain/receipt/receipt';
import { parseReceiptFileName } from '../../domain/receipt/receipt-file-name';
import { assertTransition, type ReceiptState } from '../../domain/receipt/receipt-state';
import { toSha256, type Sha256 } from '../../domain/receipt/sha256';
import { decideUpload } from '../../domain/receipt/upload-rule';
import { err, ok, type Result } from '../../domain/shared/result';
import type { FileErrorType, ReceiptErrorType } from '../../domain/shared/error-types';
import { raiseAlert } from '../alerts/raise-alert';
import { domainEvent } from '../events/domain-events';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import {
  cachedLookup,
  publishNextManifest,
  refuseBatchCommand,
  withSuppression,
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
  /** Same content already registered under the same name: not stored, not counted. */
  | 'DUPLICATE'
  /** D31: same content already registered under another valid name: both are blocked until the operator chooses. */
  | 'DUPLICATE_CONFLICT'
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
  /** D31: the receipt registered with the same content under another name. */
  readonly conflictWith?: ConflictView;
}

export interface ConflictView {
  readonly fileName: string;
  readonly period: string;
  readonly block: Block;
  readonly conceptKey?: string;
  readonly contract?: string;
  readonly state: ReceiptState;
}

const conflictView = (r: Receipt): ConflictView => ({
  fileName: r.fileName,
  period: r.period.toString(),
  block: r.block,
  conceptKey: r.conceptKey,
  contract: r.contract,
  state: r.state,
});

/** States in which a receipt can still be held back; afterwards the email may already be out (D31, point a). */
const BLOCKABLE: ReadonlySet<ReceiptState> = new Set(['PENDING', 'FAILED']);

export interface UploadSummary {
  readonly manifestVersion: number;
  readonly results: readonly UploadResult[];
}

/** A file as phase (a) leaves it: hashed, its name parsed, inspected and its contract looked up. */
interface Evaluated {
  readonly file: UploadedFile;
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly conceptKey?: string;
  readonly contract?: string;
  readonly fileError?: FileErrorType;
  readonly errorDetail?: string;
  /** What the contract source said; the suppression list is checked in phase (b). */
  readonly recipient?: RecipientResolution;
}

type Prepared = Evaluated | { readonly file: UploadedFile; readonly tooLarge: true };

const sha256Of = (content: Uint8Array) => toSha256(createHash('sha256').update(content).digest('hex'));

/**
 * Upload (§8.1) in two phases (D36). (a) Outside the serial executor: hashing, name parsing, the PDF inspector and the
 * contract lookups, which may take seconds. (b) Inside it, in one transaction: the refusals, the existing receipt of
 * each hash, the suppression list and every decision (A1, D8, D31) are taken again on the current state, then written
 * with their manifest. Another command that registered the same content in between is seen in (b).
 */
export class UploadReceipts {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(operator: string, period: Period, block: Block, files: readonly UploadedFile[]): Promise<Result<UploadSummary, BatchCommandError>> {
    // Refused at once when it is already clear, without querying anyone; checked again in phase (b).
    const early = await refuseBatchCommand(this.deps, period);
    if (early) return err(early);

    const catalog = new ConceptCatalog(await this.deps.repository.concepts.list());
    const lookup = cachedLookup(this.deps, block);
    const prepared: Prepared[] = [];
    for (const file of files) prepared.push(file.tooLarge ? { file, tooLarge: true } : await this.evaluate(file, catalog, lookup));

    return this.deps.serial.run(() => this.deps.repository.transaction((tx) => this.decide(tx, operator, period, block, prepared)));
  }

  private async decide(
    tx: BulkMailerStores,
    operator: string,
    period: Period,
    block: Block,
    prepared: readonly Prepared[],
  ): Promise<Result<UploadSummary, BatchCommandError>> {
    const refusal = await refuseBatchCommand(this.deps, period, tx);
    if (refusal) return err(refusal);

    const { fileStore, clock } = this.deps;
    const now = clock.now();

    const results: UploadResult[] = [];
    const changed: Receipt[] = [];
    const history: Array<{ sha256: Sha256; event: string; detail?: string }> = [];
    const seen = new Map<Sha256, Receipt>();
    const alerts: Alert[] = [];

    for (const item of prepared) {
      const { file } = item;
      if ('tooLarge' in item) {
        results.push({ fileName: file.name.normalize('NFC'), outcome: 'REJECTED', errorType: 'ATTACHMENT_TOO_LARGE' });
        continue;
      }
      const recipient = item.recipient && (await withSuppression(tx, item.recipient));
      const evaluated: Evaluated = { ...item, recipient };
      const existing = seen.get(evaluated.sha256) ?? (await tx.receipts.get(evaluated.sha256));
      const decision = decideUpload(existing, period, block);

      // D31: the same content under another valid name is a conflict: nothing of it is sent until the operator chooses.
      if (existing && this.isNameConflict(existing, evaluated)) {
        const conflictWith = conflictView(existing);
        if (!BLOCKABLE.has(existing.state)) {
          // Already sending or sent: it cannot be held back any more; the operator is warned (point a).
          history.push({ sha256: existing.sha256, event: 'DUPLICATE_CONFLICT', detail: `also uploaded as ${evaluated.fileName} (${period.toString()}/${block})` });
          alerts.push({
            alertId: this.deps.newId(),
            type: 'DUPLICATE_CONFLICT',
            subject: existing.sha256,
            detail: `${evaluated.fileName} has the same content as ${existing.fileName} (${existing.state}); check that it reached the right client`,
            raisedAt: now,
          });
          results.push({ fileName: evaluated.fileName, outcome: 'DUPLICATE_CONFLICT', sha256: evaluated.sha256, conflictWith });
          continue;
        }
        const name: ConflictingName = {
          fileName: evaluated.fileName,
          period,
          block,
          conceptKey: evaluated.conceptKey as string,
          contract: evaluated.contract as string,
          uploadedAt: now,
        };
        const blocked: Receipt = {
          ...existing,
          errorType: 'DUPLICATE_CONFLICT',
          conflictingNames: [...(existing.conflictingNames ?? []), name],
          fileAvailable: true,
          updatedAt: now,
        };
        // A FAILED receipt whose file was purged gets it back, so the chosen name can be sent.
        if (!existing.fileAvailable) await fileStore.save({ period: existing.period, block: existing.block, sha256: existing.sha256 }, file.content);
        const at = changed.findIndex((r) => r.sha256 === blocked.sha256);
        if (at >= 0) changed[at] = blocked;
        else changed.push(blocked);
        seen.set(blocked.sha256, blocked);
        history.push({ sha256: blocked.sha256, event: 'DUPLICATE_CONFLICT', detail: `also uploaded as ${evaluated.fileName} (${period.toString()}/${block})` });
        // The earlier result of the same content in this upload now shows the conflict too.
        for (const [i, r] of results.entries()) {
          if (r.sha256 === blocked.sha256 && r.outcome === 'REGISTERED') results[i] = { ...r, state: blocked.state, errorType: 'DUPLICATE_CONFLICT' };
        }
        results.push({ fileName: evaluated.fileName, outcome: 'DUPLICATE_CONFLICT', sha256: evaluated.sha256, conflictWith });
        continue;
      }

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
          errorType: inConflict(existing) ? 'DUPLICATE_CONFLICT' : (evaluated.recipient?.errorType ?? existing.errorType),
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
        version: existing?.version ?? 1,
      };
      if (receipt.fileAvailable) await fileStore.save({ period, block, sha256: receipt.sha256 }, file.content);
      const event = decision === 'NEW' ? 'UPLOADED' : decision === 'MOVE' ? 'MOVED' : 'UPLOADED_AGAIN';
      const detail = decision === 'MOVE' && existing ? `from ${existing.period.toString()}/${existing.block}` : undefined;
      this.track(receipt, event, detail, changed, history, seen, results);
    }

    if (changed.length === 0) {
      // Only conflicts with receipts already sent are recorded and warned; the manifest does not change.
      for (const entry of history) await tx.receipts.appendHistory({ ...entry, at: now });
      for (const alert of alerts) await raiseAlert(tx, this.deps.newId, alert);
      const batch = await tx.batches.get(period, block);
      return ok({ manifestVersion: batch?.manifestVersion ?? 0, results });
    }

    for (const receipt of changed) await tx.receipts.save(receipt);
    for (const entry of history) await tx.receipts.appendHistory({ ...entry, at: now });
    for (const alert of alerts) await raiseAlert(tx, this.deps.newId, alert);
    // D31: a conflict can block a receipt of another batch: its manifest changes too.
    const others = new Map<string, Receipt>();
    for (const r of changed) if (!(r.period.equals(period) && r.block === block)) others.set(`${r.period.toString()}/${r.block}`, r);
    for (const r of others.values()) await publishNextManifest(tx, r.period, r.block, now);
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
    return ok({ manifestVersion: published.version, results });
  }

  /** Phase (a): nothing here reads or writes the state the decision depends on. */
  private async evaluate(file: UploadedFile, catalog: ConceptCatalog, lookup: (contract: string) => Promise<RecipientResolution>): Promise<Evaluated> {
    const sha256 = sha256Of(file.content);
    const name = parseReceiptFileName(file.name, catalog, this.deps.fileNameOptions);
    const fileName = name.ok ? name.value.name : file.name.normalize('NFC');
    const parsed = name.ok ? { conceptKey: name.value.concept.key, contract: name.value.contract } : {};
    if (!name.ok) return { file, sha256, fileName, fileError: name.error };

    const verdict = await this.deps.inspector.inspect(file.content);
    if (!verdict.ok) return { file, sha256, fileName, ...parsed, fileError: verdict.error, errorDetail: verdict.detail };

    return { file, sha256, fileName, ...parsed, recipient: await lookup(name.value.contract) };
  }

  /**
   * D31: another valid name for content already registered with a valid name and not removed. An invalid name is not
   * a destination (point b, A1 applies), and a name already known is a plain duplicate.
   */
  private isNameConflict(existing: Receipt, evaluated: Evaluated): boolean {
    if (existing.state === 'REMOVED' || existing.state === 'INVALID') return false;
    if (existing.conceptKey === undefined || existing.contract === undefined) return false;
    if (evaluated.conceptKey === undefined || evaluated.contract === undefined) return false;
    if (evaluated.fileName === existing.fileName) return false;
    return !(existing.conflictingNames ?? []).some((n) => n.fileName === evaluated.fileName);
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
    // The same content twice in one upload: the last decision is the one saved, once (D37: one save per read).
    const at = changed.findIndex((r) => r.sha256 === receipt.sha256);
    if (at >= 0) changed[at] = receipt;
    else changed.push(receipt);
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
