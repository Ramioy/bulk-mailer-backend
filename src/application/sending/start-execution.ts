import { canExecute } from '../../domain/batch/batch-state';
import { diffManifests, type ManifestDifference } from '../../domain/batch/manifest';
import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import { refuseBatchCommand, type BatchCommandError } from '../receipts/receipt-dependencies';
import type { ExecutionDependencies } from './execution-dependencies';
import { readyManifestEntries } from './ready-entries';

export type StartExecutionError =
  | { readonly code: BatchCommandError | 'BATCH_NOT_FOUND' | 'BATCH_NOT_EXECUTABLE' | 'NOTHING_TO_SEND' | 'ARCHIVE_COPY_NOT_CONFIGURED' }
  /** The operator reviewed another version: nothing is sent (§8.3). */
  | { readonly code: 'MANIFEST_CHANGED'; readonly currentVersion: number; readonly differences: readonly ManifestDifference[] };

/**
 * "Send": checks that the operator reviewed the current manifest, takes the global lock and queues the
 * execution. The execution runs in the background, independent of the operator's session (D9).
 */
export class StartExecution {
  constructor(private readonly deps: ExecutionDependencies) {}

  execute(operator: string, period: Period, block: Block, reviewedVersion: number): Promise<Result<{ executionId: string }, StartExecutionError>> {
    return this.deps.serial.run(() => this.run(operator, period, block, reviewedVersion));
  }

  private async run(operator: string, period: Period, block: Block, reviewedVersion: number): Promise<Result<{ executionId: string }, StartExecutionError>> {
    const { repository, clock, newId } = this.deps;
    const refusal = await refuseBatchCommand(this.deps, period);
    if (refusal) return err({ code: refusal });

    const batch = await repository.batches.get(period, block);
    if (!batch) return err({ code: 'BATCH_NOT_FOUND' });
    if (!canExecute(batch.state)) return err({ code: 'BATCH_NOT_EXECUTABLE' });

    const current = await repository.batches.getManifest(period, block, batch.manifestVersion);
    if (!current) return err({ code: 'BATCH_NOT_FOUND' });
    if (reviewedVersion !== batch.manifestVersion) {
      const reviewed = await repository.batches.getManifest(period, block, reviewedVersion);
      return err({
        code: 'MANIFEST_CHANGED',
        currentVersion: batch.manifestVersion,
        differences: diffManifests(reviewed ?? { version: reviewedVersion, entries: [] }, current),
      });
    }
    if ((await readyManifestEntries(repository, current)).length === 0) return err({ code: 'NOTHING_TO_SEND' });

    // The archive copy setting in force when the execution starts applies to the whole execution.
    const copyEnabled = await repository.settings.archiveCopyEnabled();
    if (copyEnabled && !this.deps.archiveCopyAddress) return err({ code: 'ARCHIVE_COPY_NOT_CONFIGURED' });

    const executionId = newId();
    const now = clock.now();
    const started = await repository.transaction(async (tx) => {
      const execution = {
        executionId,
        period,
        block,
        manifestVersion: batch.manifestVersion,
        startedBy: operator,
        startedAt: now,
        ...(copyEnabled ? { copyAddress: this.deps.archiveCopyAddress } : {}),
      };
      if (!(await tx.executions.tryStart(execution))) return false;
      await tx.batches.save({ ...batch, state: 'RUNNING', stopReason: undefined, updatedAt: now });
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'BATCH_EXECUTED',
        at: now,
        subject: `${period.toString()}/${block}`,
        newValue: `manifest v${batch.manifestVersion}`,
        note: `execution ${executionId}${copyEnabled ? `, copy to ${this.deps.archiveCopyAddress}` : ''}`,
      });
      await tx.outbox.add(
        domainEvent(newId, 'EXECUTION_STARTED', now, { executionId, period: period.toString(), block, manifestVersion: batch.manifestVersion, startedBy: operator }),
      );
      return true;
    });
    if (!started) return err({ code: 'EXECUTION_IN_PROGRESS' });

    await this.deps.jobQueue.enqueue({ type: 'EXECUTE_BATCH', payload: { executionId }, runAt: now });
    return ok({ executionId });
  }
}
