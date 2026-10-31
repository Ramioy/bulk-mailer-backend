import type { ExecutionDependencies } from './execution-dependencies';
import { lastCounters, markSendingUncertain, stopExecution } from './interrupt-execution';
import { ProgressRecorder } from './progress-recorder';

const REASON = 'process restarted while sending';

/**
 * Runs at startup, before the job runner (§9.3): every receipt left SENDING becomes UNCERTAIN (it is unknown
 * whether the provider received it; reconciliation resolves it), and the execution that was running stops
 * as INTERRUPTED. The operator's abort (D32) does the same for one execution without a restart.
 */
export class RecoverAfterCrash {
  constructor(private readonly deps: ExecutionDependencies) {}

  async execute(): Promise<{ uncertain: number; interrupted?: string }> {
    const { repository, clock, newId } = this.deps;
    const now = clock.now();

    // Read in the transaction they are saved in (D37).
    const uncertain = await repository.transaction(async (tx) => {
      const sending = await tx.receipts.listByState('SENDING');
      for (const receipt of sending) {
        const attempt = (await tx.attempts.listByReceipt(receipt.sha256)).at(-1);
        await markSendingUncertain(tx, newId, now, receipt, REASON, attempt);
      }
      return sending.length;
    });

    const running = await repository.executions.running();
    if (!running) return { uncertain };

    await repository.transaction((tx) => stopExecution(tx, newId, now, running, 'INTERRUPTED'));
    await new ProgressRecorder(repository, this.deps.progress, clock).emit(running.executionId, {
      type: 'FINISHED',
      batchState: 'STOPPED',
      stopReason: 'INTERRUPTED',
      counters: await lastCounters(repository, running.executionId),
    });
    return { uncertain, interrupted: running.executionId };
  }
}
