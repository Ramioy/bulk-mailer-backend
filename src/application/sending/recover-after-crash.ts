import type { ExecutionDependencies } from './execution-dependencies';
import { ProgressRecorder } from './progress-recorder';
import { raiseAlert } from '../alerts/raise-alert';

/**
 * Runs at startup, before the job runner (§9.3): every receipt left SENDING becomes UNCERTAIN (it is unknown
 * whether the provider received it; reconciliation resolves it), and the execution that was running stops
 * as INTERRUPTED.
 */
export class RecoverAfterCrash {
  constructor(private readonly deps: ExecutionDependencies) {}

  async execute(): Promise<{ uncertain: number; interrupted?: string }> {
    const { repository, clock, newId } = this.deps;
    const now = clock.now();

    const sending = await repository.receipts.listByState('SENDING');
    await repository.transaction(async (tx) => {
      for (const receipt of sending) {
        await tx.receipts.save({ ...receipt, state: 'UNCERTAIN', updatedAt: now });
        await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'UNCERTAIN', detail: 'process restarted while sending' });
      }
    });

    const running = await repository.executions.running();
    if (!running) return { uncertain: sending.length };

    const batch = await repository.batches.get(running.period, running.block);
    await repository.transaction(async (tx) => {
      await tx.executions.save({ ...running, finishedAt: now, result: 'STOPPED', stopReason: 'INTERRUPTED' });
      if (batch) await tx.batches.save({ ...batch, state: 'STOPPED', stopReason: 'INTERRUPTED', updatedAt: now });
    });
    const last = await repository.executionEvents.last(running.executionId);
    const counters = last && 'counters' in last.event ? last.event.counters : { total: 0, processed: 0, byState: {}, byErrorType: {} };
    await new ProgressRecorder(repository, this.deps.progress, clock).emit(running.executionId, {
      type: 'FINISHED',
      batchState: 'STOPPED',
      stopReason: 'INTERRUPTED',
      counters,
    });
    await raiseAlert(repository.alerts, this.deps.alertNotifiers, {
      alertId: newId(),
      type: 'BATCH_STOPPED',
      subject: running.executionId,
      detail: `${running.period.toString()}/${running.block} stopped: INTERRUPTED`,
      raisedAt: now,
    });
    return { uncertain: sending.length, interrupted: running.executionId };
  }
}
