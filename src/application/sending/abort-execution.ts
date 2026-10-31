import { err, ok, type Result } from '../../domain/shared/result';
import type { StoredProgressEvent } from '../../ports/progress-notifier';
import type { ExecutionDependencies } from './execution-dependencies';
import { lastCounters, markSendingUncertain, stopExecution } from './interrupt-execution';
import { ProgressRecorder } from './progress-recorder';

export type AbortExecutionError =
  | { readonly code: 'NOTE_REQUIRED' | 'EXECUTION_NOT_FOUND' | 'EXECUTION_NOT_RUNNING' }
  /** It made progress recently: it is probably healthy (waiting or sending). `force` overrides it. */
  | { readonly code: 'EXECUTION_STILL_ACTIVE'; readonly lastActivityAt: string; readonly abortableAt: string };

export interface AbortedExecution {
  readonly executionId: string;
  readonly result: 'STOPPED';
  readonly stopReason: 'INTERRUPTED';
  /** Receipts that were SENDING and are now UNCERTAIN; reconciliation resolves them. */
  readonly uncertain: readonly string[];
}

/**
 * D32: the operator's emergency exit for an execution that stopped making progress (e.g. its job failed in a way
 * that could not stop it, or the process hangs), without restarting the service. It does what the recovery at
 * startup does, for this execution only: its SENDING receipts become UNCERTAIN and it stops as INTERRUPTED.
 * Audited, with a mandatory note. If the run is in fact still alive, it notices at its next write and stops (D32).
 */
export class AbortExecution {
  private readonly progress: ProgressRecorder;

  constructor(private readonly deps: ExecutionDependencies) {
    this.progress = new ProgressRecorder(deps.repository, deps.progress, deps.clock);
  }

  execute(operator: string, executionId: string, rawNote: string, force: boolean): Promise<Result<AbortedExecution, AbortExecutionError>> {
    return this.deps.serial.run(() => this.run(operator, executionId, rawNote.trim(), force));
  }

  private async run(operator: string, executionId: string, note: string, force: boolean): Promise<Result<AbortedExecution, AbortExecutionError>> {
    const { repository, clock, newId } = this.deps;
    if (note === '') return err({ code: 'NOTE_REQUIRED' });
    const execution = await repository.executions.get(executionId);
    if (!execution) return err({ code: 'EXECUTION_NOT_FOUND' });
    // A second abort (double click) lands here: the first one already ended it.
    if (execution.finishedAt) return err({ code: 'EXECUTION_NOT_RUNNING' });

    const now = clock.now();
    const lastActivity = lastActivityAt(await repository.executionEvents.last(executionId)) ?? execution.startedAt;
    const abortableAt = new Date(lastActivity.getTime() + this.deps.abortAfterMinutes * 60_000);
    if (!force && now < abortableAt) {
      return err({ code: 'EXECUTION_STILL_ACTIVE', lastActivityAt: lastActivity.toISOString(), abortableAt: abortableAt.toISOString() });
    }

    const reason = `execution aborted by ${operator}`;
    const uncertain = await repository.transaction(async (tx) => {
      const released: string[] = [];
      for (const receipt of await tx.receipts.listByState('SENDING')) {
        // Only this execution's receipts; the latest attempt says who took it.
        const attempt = (await tx.attempts.listByReceipt(receipt.sha256)).at(-1);
        if (attempt?.executionId !== executionId) continue;
        await markSendingUncertain(tx, newId, now, receipt, reason, attempt);
        released.push(receipt.sha256);
      }
      await stopExecution(tx, newId, now, execution, 'INTERRUPTED');
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'EXECUTION_ABORTED',
        at: now,
        subject: executionId,
        previousValue: `RUNNING ${execution.period.toString()}/${execution.block}, last activity ${lastActivity.toISOString()}`,
        newValue: `STOPPED / INTERRUPTED, ${released.length} receipt(s) UNCERTAIN`,
        note: force ? `[forced] ${note}` : note,
      });
      return released;
    });
    await this.progress.emit(executionId, {
      type: 'FINISHED',
      batchState: 'STOPPED',
      stopReason: 'INTERRUPTED',
      counters: await lastCounters(repository, executionId),
    });
    return ok({ executionId, result: 'STOPPED', stopReason: 'INTERRUPTED', uncertain });
  }
}

/** When the run last showed life. A growing wait is announced before it starts: it counts until `nextSendAt`. */
function lastActivityAt(last: StoredProgressEvent | undefined): Date | undefined {
  if (!last) return undefined;
  if (last.event.type !== 'WAITING') return last.at;
  const nextSendAt = new Date(last.event.nextSendAt);
  return nextSendAt > last.at ? nextSendAt : last.at;
}
