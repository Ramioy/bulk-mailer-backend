import type { Execution } from '../../domain/batch/batch';
import type { BatchState } from '../../domain/batch/batch-state';
import type { BatchStopReason } from '../../domain/shared/error-types';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { ProgressCounters } from '../../ports/progress-notifier';

export interface ExecutionStatus {
  readonly executionId: string;
  readonly period: string;
  readonly block: string;
  readonly manifestVersion: number;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly copyAddress?: string;
  readonly finishedAt?: string;
  readonly result?: 'COMPLETED' | 'STOPPED';
  readonly stopReason?: BatchStopReason;
  readonly batchState?: BatchState;
  readonly counters: ProgressCounters;
  /** Present while the batch pauses after an uncertain response. */
  readonly waiting?: { readonly reason: string; readonly seconds: number; readonly consecutiveIncidents: number; readonly nextSendAt: string };
  /** Pass it as `Last-Event-ID` to follow the progress live from here. */
  readonly lastEventSeq: number;
}

const NO_COUNTERS: ProgressCounters = { total: 0, processed: 0, byState: {}, byErrorType: {} };

/** State of an execution, entirely from the database: a new session sees it whatever happened before (D10). */
export class GetExecution {
  constructor(private readonly deps: { readonly repository: BulkMailerRepository; readonly clock: Clock }) {}

  /** The running execution, or the last one. */
  async current(): Promise<ExecutionStatus | undefined> {
    const { executions } = this.deps.repository;
    const execution = (await executions.running()) ?? (await executions.latest());
    return execution && this.status(execution);
  }

  async byId(executionId: string): Promise<ExecutionStatus | undefined> {
    const execution = await this.deps.repository.executions.get(executionId);
    return execution && this.status(execution);
  }

  private async status(execution: Execution): Promise<ExecutionStatus> {
    const { repository, clock } = this.deps;
    const events = await repository.executionEvents.listAfter(execution.executionId, 0);
    const withCounters = [...events].reverse().find((e) => 'counters' in e.event);
    const last = events.at(-1);
    const waiting =
      !execution.finishedAt && last?.event.type === 'WAITING' && new Date(last.event.nextSendAt) > clock.now()
        ? { reason: last.event.reason, seconds: last.event.seconds, consecutiveIncidents: last.event.consecutiveIncidents, nextSendAt: last.event.nextSendAt }
        : undefined;
    const batch = await repository.batches.get(execution.period, execution.block);
    return {
      executionId: execution.executionId,
      period: execution.period.toString(),
      block: execution.block,
      manifestVersion: execution.manifestVersion,
      startedBy: execution.startedBy,
      startedAt: execution.startedAt.toISOString(),
      copyAddress: execution.copyAddress,
      finishedAt: execution.finishedAt?.toISOString(),
      result: execution.result,
      stopReason: execution.stopReason,
      batchState: batch?.state,
      counters: withCounters && 'counters' in withCounters.event ? withCounters.event.counters : NO_COUNTERS,
      waiting,
      lastEventSeq: last?.seq ?? 0,
    };
  }
}
