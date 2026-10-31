import { type Block, contractSourceOf } from '../../domain/block/block';
import { buildManifest, type Manifest } from '../../domain/batch/manifest';
import { assertBatchTransition } from '../../domain/batch/batch-state';
import type { FileNameOptions } from '../../domain/receipt/receipt-file-name';
import { Period } from '../../domain/period/period';
import { inConflict } from '../../domain/receipt/receipt';
import { resolveRecipient, type Recipient } from '../../domain/recipient/recipient';
import { RecipientErrorType } from '../../domain/shared/error-types';
import type { BulkMailerRepository, BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { ContractSources } from '../../ports/contract-source';
import type { FileInspector } from '../../ports/file-inspector';
import type { ReceiptFileStore } from '../../ports/receipt-file-store';
import type { SerialExecutor } from '../shared/serial-executor';

export interface ReceiptDependencies {
  readonly repository: BulkMailerRepository;
  readonly fileStore: ReceiptFileStore;
  readonly inspector: FileInspector;
  readonly contractSources: ContractSources;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly serial: SerialExecutor;
  readonly timeZone: string;
  readonly fileNameOptions: FileNameOptions;
}

export type BatchCommandError = 'PERIOD_NOT_OPERABLE' | 'EXECUTION_IN_PROGRESS';

/**
 * Refusals shared by every command that changes a batch. Commands check it again inside the serial executor, on the
 * stores of their transaction (D36): an execution may have started while they were querying outside.
 */
export async function refuseBatchCommand(
  deps: Pick<ReceiptDependencies, 'repository' | 'clock' | 'timeZone'>,
  period: Period,
  stores: Pick<BulkMailerStores, 'executions'> = deps.repository,
): Promise<BatchCommandError | undefined> {
  if (!Period.isOperable(period, deps.clock.now(), deps.timeZone)) return 'PERIOD_NOT_OPERABLE';
  // While an execution runs, upload, remove, send and resend are disabled in the whole system.
  if (await stores.executions.running()) return 'EXECUTION_IN_PROGRESS';
  return undefined;
}

/**
 * D50 (B3): removing a receipt or resolving a duplicate conflict corrects data and sends nothing, so it is allowed in
 * any period (a conflict from three months ago must be solvable); only a running execution refuses it.
 */
export async function refuseCorrection(stores: Pick<BulkMailerStores, 'executions'>): Promise<'EXECUTION_IN_PROGRESS' | undefined> {
  return (await stores.executions.running()) ? 'EXECUTION_IN_PROGRESS' : undefined;
}

export interface RecipientResolution {
  readonly recipient?: Recipient;
  readonly errorType?: RecipientErrorType;
}

/**
 * Phase (a) of a command (D36), outside the serial executor: what the block's contract source says. The local
 * suppression list is not checked here but in phase (b), so a hard bounce processed meanwhile is honoured.
 */
export async function lookupRecipient(deps: Pick<ReceiptDependencies, 'contractSources'>, block: Block, contract: string): Promise<RecipientResolution> {
  const resolved = resolveRecipient(await deps.contractSources[contractSourceOf(block)].get(contract), () => false);
  return resolved.ok ? { recipient: resolved.value } : { errorType: resolved.error };
}

/** One lookup per contract within a command: several receipts of the same contract share it. */
export function cachedLookup(deps: Pick<ReceiptDependencies, 'contractSources'>, block: Block): (contract: string) => Promise<RecipientResolution> {
  const cache = new Map<string, Promise<RecipientResolution>>();
  return (contract) => {
    let pending = cache.get(contract);
    if (!pending) {
      pending = lookupRecipient(deps, block, contract);
      cache.set(contract, pending);
    }
    return pending;
  };
}

/** Phase (b), inside the transaction: a usable recipient whose address is suppressed is EMAIL_SUPPRESSED. */
export async function withSuppression(stores: Pick<BulkMailerStores, 'suppressions'>, resolution: RecipientResolution): Promise<RecipientResolution> {
  if (!resolution.recipient) return resolution;
  if (await stores.suppressions.get(resolution.recipient.email)) return { errorType: RecipientErrorType.EMAIL_SUPPRESSED };
  return resolution;
}

const RECIPIENT_ERRORS: ReadonlySet<string> = new Set(Object.values(RecipientErrorType));

export function isRecipientError(errorType: string | undefined): boolean {
  return errorType !== undefined && RECIPIENT_ERRORS.has(errorType);
}

/**
 * Builds and stores the next manifest version of the batch, creating the batch on first use.
 * A COMPLETED or STOPPED batch becomes OPEN again.
 */
export async function publishNextManifest(stores: BulkMailerStores, period: Period, block: Block, now: Date): Promise<Manifest> {
  const batch = await stores.batches.get(period, block);
  if (batch) assertBatchTransition(batch.state, 'OPEN');

  const receipts = await stores.receipts.listByBatch(period, block);
  const manifest = buildManifest(
    batch?.manifestVersion ?? 0,
    receipts.map((r) => ({
      sha256: r.sha256,
      state: r.state,
      fileName: r.fileName,
      conceptKey: r.conceptKey ?? '',
      contract: r.contract ?? '',
      email: r.recipient?.email,
      fileAvailable: r.fileAvailable,
      inConflict: inConflict(r),
    })),
  );
  await stores.batches.save({ period, block, state: 'OPEN', manifestVersion: manifest.version, updatedAt: now, version: batch?.version ?? 1 });
  await stores.batches.saveManifest(period, block, manifest);
  return manifest;
}
