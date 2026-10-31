import { type Block, contractSourceOf } from '../../domain/block/block';
import { buildManifest, type Manifest } from '../../domain/batch/manifest';
import { assertBatchTransition } from '../../domain/batch/batch-state';
import type { FileNameOptions } from '../../domain/receipt/receipt-file-name';
import { Period } from '../../domain/period/period';
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

/** Refusals shared by every command that changes a batch. */
export type BatchCommandError = 'PERIOD_NOT_OPERABLE' | 'EXECUTION_IN_PROGRESS';

export async function refuseBatchCommand(deps: ReceiptDependencies, period: Period): Promise<BatchCommandError | undefined> {
  if (!Period.isOperable(period, deps.clock.now(), deps.timeZone)) return 'PERIOD_NOT_OPERABLE';
  // While an execution runs, upload, remove, send and resend are disabled in the whole system.
  if (await deps.repository.executions.running()) return 'EXECUTION_IN_PROGRESS';
  return undefined;
}

export interface RecipientResolution {
  readonly recipient?: Recipient;
  readonly errorType?: RecipientErrorType;
}

/** Queries the block's contract source and checks the local suppression list. */
export async function resolveRecipientFor(deps: ReceiptDependencies, block: Block, contract: string): Promise<RecipientResolution> {
  const lookup = await deps.contractSources[contractSourceOf(block)].get(contract);
  const resolved = resolveRecipient(lookup, () => false);
  if (!resolved.ok) return { errorType: resolved.error };
  if (await deps.repository.suppressions.get(resolved.value.email)) return { errorType: RecipientErrorType.EMAIL_SUPPRESSED };
  return { recipient: resolved.value };
}

/** One lookup per contract within a command: several receipts of the same contract share it. */
export function cachedResolver(deps: ReceiptDependencies, block: Block): (contract: string) => Promise<RecipientResolution> {
  const cache = new Map<string, Promise<RecipientResolution>>();
  return (contract) => {
    let pending = cache.get(contract);
    if (!pending) {
      pending = resolveRecipientFor(deps, block, contract);
      cache.set(contract, pending);
    }
    return pending;
  };
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
    })),
  );
  await stores.batches.save({ period, block, state: 'OPEN', manifestVersion: manifest.version, updatedAt: now });
  await stores.batches.saveManifest(period, block, manifest);
  return manifest;
}
