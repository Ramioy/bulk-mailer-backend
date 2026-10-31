import type { Execution } from '../../domain/batch/batch';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { StoredProgressEvent } from '../../ports/progress-notifier';

/** D50 (B4): what the SSE stream reads from the store, behind a use case instead of the controller. */
export class ExecutionEventsQuery {
  constructor(private readonly deps: { readonly repository: BulkMailerRepository }) {}

  execution(executionId: string): Promise<Execution | undefined> {
    return this.deps.repository.executions.get(executionId);
  }

  /** Stored events after `afterSeq`, in order (D11). */
  eventsAfter(executionId: string, afterSeq: number): Promise<StoredProgressEvent[]> {
    return this.deps.repository.executionEvents.listAfter(executionId, afterSeq);
  }

  async isFinished(executionId: string): Promise<boolean> {
    return (await this.deps.repository.executions.get(executionId))?.finishedAt !== undefined;
  }
}
