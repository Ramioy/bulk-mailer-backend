import { createHash } from 'node:crypto';

import type { Execution } from '../../domain/batch/batch';
import { assertBatchTransition } from '../../domain/batch/batch-state';
import type { ManifestEntry } from '../../domain/batch/manifest';
import { contractSourceOf } from '../../domain/block/block';
import type { Receipt } from '../../domain/receipt/receipt';
import { assertTransition, canTransition, type ReceiptState } from '../../domain/receipt/receipt-state';
import { resolveRecipient } from '../../domain/recipient/recipient';
import type { Attempt } from '../../domain/sending/attempt';
import { ProviderIncidentTracker, SourceIncidentTracker } from '../../domain/sending/incident-policy';
import { resolveSendOutcome, type SendOutcome } from '../../domain/sending/send-outcome';
import { BatchStopReason, SendErrorType, type ReceiptErrorType } from '../../domain/shared/error-types';
import { raiseAlert, unknownRejectionAlert } from '../alerts/raise-alert';
import { applyPendingEvents } from '../delivery/apply-delivery-event';
import { domainEvent } from '../events/domain-events';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { DomainEventType } from '../../ports/event-bus';
import { renderEmail } from './email-template';
import type { ExecutionDependencies } from './execution-dependencies';
import { Counters, ProgressRecorder } from './progress-recorder';
import { readyManifestEntries } from './ready-entries';

type Step = {
  readonly stop?: BatchStopReason;
  /** The execution was ended by someone else (the operator's abort, D32): this run stops without touching anything. */
  readonly abandoned?: true;
};

/** The receipt in progress, so that an unexpected exception can release it correctly (D32). */
interface InFlight {
  /** Set once the attempt is about to be recorded (the receipt goes SENDING in the same transaction). */
  attempt?: Attempt;
  /** Set right before calling the provider: from then on the email may have left. */
  providerCalled: boolean;
}

/** Longest error text kept in histories and alerts. */
const MAX_CAUSE_LENGTH = 300;

/**
 * Processes one execution: its manifest receipts one at a time, with a pause between sends,
 * growing waits after uncertain responses and a stop after three consecutive incidents.
 * There are no automatic retries: a receipt is sent at most once per execution.
 *
 * An unexpected exception stops the execution as INTERNAL_ERROR instead of leaving the global lock taken (D32);
 * an aborted `signal` (shutdown) lets the receipt in progress finish and stops it as INTERRUPTED (D33).
 */
export class RunExecution {
  private readonly progress: ProgressRecorder;

  constructor(private readonly deps: ExecutionDependencies) {
    this.progress = new ProgressRecorder(deps.repository, deps.progress, deps.clock);
  }

  async execute(executionId: string, signal?: AbortSignal): Promise<void> {
    const { repository } = this.deps;
    const execution = await repository.executions.get(executionId);
    // Already finished (stopped as INTERRUPTED by crash recovery or aborted by the operator): nothing to do.
    if (!execution || execution.finishedAt) return;

    let counters = new Counters(0);
    let inFlight: InFlight = { providerCalled: false };
    try {
      const manifest = await repository.batches.getManifest(execution.period, execution.block, execution.manifestVersion);
      const entries = manifest ? await readyManifestEntries(repository, manifest) : [];
      counters = new Counters(entries.length);
      await this.progress.emit(executionId, { type: 'STARTED', counters: counters.snapshot() });

      const providerIncidents = new ProviderIncidentTracker(this.deps.incidentPolicy);
      const sourceIncidents = new SourceIncidentTracker(this.deps.incidentPolicy.stopAfter);

      for (const [index, entry] of entries.entries()) {
        if (index > 0 && !signal?.aborted) await this.deps.clock.sleep(this.deps.pauseBetweenSendsMs, signal);
        // Shutdown (D33): checked only between receipts, so the one in progress always gets its outcome recorded.
        if (signal?.aborted) return await this.finish(execution, counters, BatchStopReason.INTERRUPTED);
        inFlight = { providerCalled: false };
        const step = await this.sendOne(execution, entry, counters, providerIncidents, sourceIncidents, inFlight, signal);
        if (step.abandoned) return;
        if (step.stop) return await this.finish(execution, counters, step.stop);
      }
      return await this.finish(execution, counters);
    } catch (error) {
      await this.stopAfterError(execution, counters, inFlight, error);
      // Still thrown, so the job is marked failed and the cause is logged; the state is consistent by now.
      throw error;
    }
  }

  /**
   * D32: an exception nobody classified (disk, database, a bug) must not leave the execution RUNNING, which blocks
   * every command of every batch until a restart. The receipt in progress is released and the execution ends
   * STOPPED / INTERNAL_ERROR like any other stop. If this fails too (e.g. the database is down), the error propagates:
   * the operator's abort or the recovery at the next start covers it.
   */
  private async stopAfterError(execution: Execution, counters: Counters, inFlight: InFlight, error: unknown): Promise<void> {
    const cause = describeError(error);
    try {
      if (inFlight.attempt) await this.releaseInFlight(execution, inFlight.attempt, inFlight.providerCalled, cause, counters);
      await this.finish(execution, counters, BatchStopReason.INTERNAL_ERROR);
    } catch (secondary) {
      throw new AggregateError([error, secondary], `${cause}; stopping the execution failed too: ${describeError(secondary)}`, { cause: secondary });
    }
  }

  /**
   * The receipt left SENDING by the exception: UNCERTAIN if the provider may have been called (reconciliation
   * resolves it; never sent again blindly, C2), PENDING if it certainly was not (it stays ready for the next send).
   */
  private async releaseInFlight(execution: Execution, attempt: Attempt, providerCalled: boolean, cause: string, counters: Counters): Promise<void> {
    const now = this.deps.clock.now();
    const state = providerCalled ? 'UNCERTAIN' : 'PENDING';
    const released = await this.write(async (tx) => {
      // Re-read here: the exception may have hit before the attempt was stored or after its outcome was recorded.
      const receipt = await tx.receipts.get(attempt.sha256);
      if (receipt?.state !== 'SENDING' || !(await tx.attempts.get(attempt.attemptId))) return false;
      assertTransition(receipt.state, state);
      const updated: Receipt = { ...receipt, state, errorType: undefined, errorDetail: `internal error: ${cause}`, updatedAt: now };
      await tx.attempts.save(
        providerCalled
          ? { ...attempt, finishedAt: now, outcome: 'UNCERTAIN', detail: `internal error after calling the provider: ${cause}` }
          : { ...attempt, finishedAt: now, detail: `not sent: internal error (${cause})` },
      );
      await tx.receipts.save(updated);
      await tx.receipts.appendHistory({
        sha256: attempt.sha256,
        at: now,
        event: state,
        detail: `internal error ${providerCalled ? 'after' : 'before'} calling the provider: ${cause}`,
      });
      await tx.outbox.add(
        this.receiptEvent(providerCalled ? 'RECEIPT_UNCERTAIN' : 'RECEIPT_SEND_FAILED', now, execution, attempt, { state, reason: 'INTERNAL_ERROR', providerCalled }),
      );
      return true;
    });
    // Counted in the FINISHED event; no RECEIPT_PROCESSED here, so nothing else can fail before the execution ends.
    if (released) counters.record(state);
  }

  private async sendOne(
    execution: Execution,
    entry: ManifestEntry,
    counters: Counters,
    providerIncidents: ProviderIncidentTracker,
    sourceIncidents: SourceIncidentTracker,
    inFlight: InFlight,
    signal?: AbortSignal,
  ): Promise<Step> {
    const { repository, fileStore, contractSources, emailProvider, clock, newId } = this.deps;
    // The attempt is recorded before anything else, so every provider call is traceable (§9.1).
    const attempt: Attempt = {
      attemptId: newId(),
      sha256: entry.sha256,
      executionId: execution.executionId,
      kind: 'BATCH',
      to: entry.email,
      copyAddress: execution.copyAddress,
      startedAt: clock.now(),
    };
    inFlight.attempt = attempt;
    const started = await this.write(async (tx): Promise<Receipt | 'ABANDONED' | Receipt['state']> => {
      // Ended meanwhile by the operator's abort (D32): this run must not take another receipt.
      if ((await tx.executions.get(execution.executionId))?.finishedAt) return 'ABANDONED';
      // Read here, not when the execution started: late evidence may have made it SENT meanwhile (D34). SENT → SENDING
      // is a legal transition (manual Resend), so without this check it would be sent again.
      const receipt = (await tx.receipts.get(entry.sha256)) as Receipt;
      if (receipt.state !== 'PENDING' && receipt.state !== 'FAILED') return receipt.state;
      assertTransition(receipt.state, 'SENDING');
      const sending: Receipt = { ...receipt, state: 'SENDING', attempts: receipt.attempts + 1, updatedAt: clock.now() };
      await tx.attempts.insert(attempt);
      await tx.receipts.save(sending);
      await tx.receipts.appendHistory({ sha256: entry.sha256, at: clock.now(), event: 'SENDING', detail: `attempt ${attempt.attemptId}` });
      return sending;
    });
    if (started === 'ABANDONED') return { abandoned: true };
    if (typeof started === 'string') return this.skipNotReady(execution, entry, started, counters);
    const sending = started;

    // Same hash as reviewed.
    const content = await fileStore.read({ period: execution.period, block: execution.block, sha256: entry.sha256 });
    if (!content) return this.failBeforeSending(execution, sending, attempt, counters, SendErrorType.FILE_NOT_AVAILABLE);
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      return this.failBeforeSending(execution, sending, attempt, counters, SendErrorType.FILE_MODIFIED);
    }

    // Same email as reviewed, and not suppressed.
    const lookup = await contractSources[contractSourceOf(execution.block)].get(entry.contract);
    const sourceDecision = sourceIncidents.register(lookup.kind !== 'UNAVAILABLE');
    const resolved = resolveRecipient(lookup, () => false);
    if (!resolved.ok) {
      const step = await this.failBeforeSending(execution, sending, attempt, counters, resolved.error);
      return sourceDecision.action === 'STOP' && !step.abandoned ? { stop: sourceDecision.reason } : step;
    }
    if (await repository.suppressions.get(resolved.value.email)) {
      return this.failBeforeSending(execution, sending, attempt, counters, 'EMAIL_SUPPRESSED');
    }
    if (resolved.value.email !== entry.email) {
      return this.failBeforeSending(execution, sending, attempt, counters, SendErrorType.RECIPIENT_CHANGED, `now ${resolved.value.email}`);
    }

    const concept = (await repository.concepts.list()).find((c) => c.key === entry.conceptKey) ?? { subject: entry.conceptKey };
    const { subject, textBody } = renderEmail(this.deps.emailTemplate, {
      concept,
      period: execution.period,
      complexName: resolved.value.complexName,
      fileName: entry.fileName,
    });
    // An abort while this receipt was being checked already released it as UNCERTAIN: do not call the provider.
    if ((await repository.receipts.get(entry.sha256))?.state !== 'SENDING') {
      await this.write((tx) => tx.attempts.save({ ...attempt, finishedAt: clock.now(), detail: 'not sent: the execution was aborted' }));
      return { abandoned: true };
    }
    inFlight.providerCalled = true;
    const outcome = await emailProvider.send({
      attemptId: attempt.attemptId,
      to: entry.email,
      copyTo: execution.copyAddress,
      subject,
      textBody,
      attachment: { name: entry.fileName, content },
    });
    const resolution = resolveSendOutcome(outcome);
    if (!(await this.recordOutcome(execution, sending, attempt, outcome, counters, resolution.receiptState, resolution.errorType))) return { abandoned: true };
    if (resolution.stopBatch) return { stop: resolution.stopBatch };

    const decision = providerIncidents.register(outcome);
    if (decision.action === 'STOP') return { stop: decision.reason };
    // On shutdown no growing wait starts: the loop stops the execution as INTERRUPTED right after (D33).
    if (decision.action === 'WAIT' && !signal?.aborted) {
      // Reported before the wait starts, so the operator knows the batch is waiting, not stuck.
      const nextSendAt = new Date(clock.now().getTime() + decision.seconds * 1000);
      await this.progress.emit(execution.executionId, {
        type: 'WAITING',
        reason: outcome.kind === 'ACCEPTED' ? outcome.kind : outcome.detail,
        seconds: decision.seconds,
        consecutiveIncidents: decision.consecutiveIncidents,
        nextSendAt: nextSendAt.toISOString(),
      });
      await clock.sleep(decision.seconds * 1000, signal);
    }
    return {};
  }

  /** D34: the receipt stopped being ready after the execution started (e.g. late evidence made it SENT): not sent. */
  private async skipNotReady(execution: Execution, entry: ManifestEntry, state: Receipt['state'], counters: Counters): Promise<Step> {
    const now = this.deps.clock.now();
    await this.write((tx) => tx.receipts.appendHistory({ sha256: entry.sha256, at: now, event: 'SKIPPED', detail: `${state} when its turn came in execution ${execution.executionId}` }));
    counters.record(state);
    await this.progress.emit(execution.executionId, { type: 'RECEIPT_PROCESSED', sha256: entry.sha256, fileName: entry.fileName, state, counters: counters.snapshot() });
    return {};
  }

  /**
   * Changes to receipts go through the serial executor in short sections: the execution itself runs outside it,
   * in parallel to the delivery lane (D21), and must not overwrite what that lane records.
   */
  private write<T>(work: (tx: BulkMailerStores) => Promise<T>): Promise<T> {
    return this.deps.serial.run(() => this.deps.repository.transaction(work));
  }

  private async failBeforeSending(
    execution: Execution,
    sending: Receipt,
    attempt: Attempt,
    counters: Counters,
    errorType: ReceiptErrorType,
    detail?: string,
  ): Promise<Step> {
    const now = this.deps.clock.now();
    const failed: Receipt = { ...sending, state: 'FAILED', errorType, errorDetail: detail, updatedAt: now };
    const live = await this.write(async (tx) => {
      const finished = { ...attempt, finishedAt: now, detail: `not sent: ${errorType}${detail ? ` (${detail})` : ''}` };
      const current = await this.applicable(tx, attempt, finished, 'FAILED');
      if (current === 'NOT_APPLICABLE') return false;
      await tx.attempts.save(finished);
      await tx.receipts.save(failed);
      await tx.receipts.appendHistory({ sha256: failed.sha256, at: now, event: 'FAILED', detail: current === 'SENDING' ? errorType : `${errorType} (after the execution was aborted)` });
      await tx.outbox.add(this.receiptEvent('RECEIPT_SEND_FAILED', now, execution, attempt, { errorType, providerCalled: false }));
      return current === 'SENDING';
    });
    if (!live) return { abandoned: true };
    counters.record('FAILED', errorType);
    await this.emitProcessed(execution, failed, counters);
    return {};
  }

  private async recordOutcome(
    execution: Execution,
    sending: Receipt,
    attempt: Attempt,
    outcome: SendOutcome,
    counters: Counters,
    state: Receipt['state'],
    errorType: ReceiptErrorType | undefined,
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    assertTransition('SENDING', state);
    const detail = outcome.kind === 'ACCEPTED' ? undefined : outcome.detail;
    const updated: Receipt = {
      ...sending,
      state,
      errorType,
      errorDetail: detail,
      ...(state === 'SENT' ? { deliveryState: 'UNCONFIRMED' as const } : {}),
      updatedAt: now,
    };
    const live = await this.write(async (tx) => {
      const finished: Attempt = {
        ...attempt,
        finishedAt: now,
        outcome: outcome.kind,
        detail,
        providerRequestId: outcome.kind === 'ACCEPTED' ? outcome.providerRequestId : undefined,
      };
      const current = await this.applicable(tx, attempt, finished, state);
      if (current === 'NOT_APPLICABLE') return false;
      await tx.attempts.save(finished);
      await tx.receipts.save(updated);
      const historyDetail = detail ?? outcome.kind;
      await tx.receipts.appendHistory({
        sha256: updated.sha256,
        at: now,
        event: state,
        detail: current === 'SENDING' ? historyDetail : `${historyDetail} (after the execution was aborted)`,
      });
      const type: DomainEventType = state === 'SENT' ? 'RECEIPT_SENT' : state === 'UNCERTAIN' ? 'RECEIPT_UNCERTAIN' : 'RECEIPT_SEND_FAILED';
      await tx.outbox.add(this.receiptEvent(type, now, execution, attempt, { state, outcome: outcome.kind, errorType, providerCalled: true }));
      if (outcome.kind === 'UNKNOWN_REJECTION') await unknownRejectionAlert(tx, this.deps.newId, now, updated, outcome.detail);
      // Delivery events that arrived while it was SENDING (D21).
      if (state === 'SENT' || state === 'UNCERTAIN') await applyPendingEvents(tx, this.deps.newId, now, attempt.attemptId);
      return current === 'SENDING';
    });
    if (!live) return false;
    counters.record(state, errorType);
    await this.emitProcessed(execution, updated, counters);
    return true;
  }

  /**
   * Whether the outcome of this attempt can still be applied to its receipt. Normally the receipt is SENDING. If the
   * operator aborted the execution meanwhile (D32), the receipt is already UNCERTAIN: a certain outcome (SENT, or
   * FAILED without sending) still settles it, as reconciliation would; anything else is only kept on the attempt.
   */
  private async applicable(tx: BulkMailerStores, attempt: Attempt, finished: Attempt, state: ReceiptState): Promise<ReceiptState | 'NOT_APPLICABLE'> {
    const current = (await tx.receipts.get(attempt.sha256))?.state;
    if (current === 'SENDING') return current;
    if (current && canTransition(current, state)) return current;
    await tx.attempts.save(finished);
    await tx.receipts.appendHistory({
      sha256: attempt.sha256,
      at: finished.finishedAt ?? this.deps.clock.now(),
      event: 'OUTCOME_NOT_APPLIED',
      detail: `attempt ${attempt.attemptId} ended ${state} with the receipt ${current ?? 'missing'}: the execution had been aborted`,
    });
    return 'NOT_APPLICABLE';
  }

  private receiptEvent(type: DomainEventType, at: Date, execution: Execution, attempt: Attempt, extra: Record<string, unknown>) {
    return domainEvent(this.deps.newId, type, at, {
      sha256: attempt.sha256,
      attemptId: attempt.attemptId,
      executionId: execution.executionId,
      ...extra,
    });
  }

  private async emitProcessed(execution: Execution, receipt: Receipt, counters: Counters): Promise<void> {
    await this.progress.emit(execution.executionId, {
      type: 'RECEIPT_PROCESSED',
      sha256: receipt.sha256,
      fileName: receipt.fileName,
      state: receipt.state,
      errorType: receipt.errorType,
      counters: counters.snapshot(),
    });
  }

  private async finish(execution: Execution, counters: Counters, stopReason?: BatchStopReason): Promise<void> {
    const { fileStore, clock, newId } = this.deps;
    const now = clock.now();
    const result = stopReason ? 'STOPPED' : 'COMPLETED';

    const finished = await this.write(async (tx) => {
      // Already ended by the operator's abort (D32), or by an earlier finish that failed after its commit: keep that.
      if ((await tx.executions.get(execution.executionId))?.finishedAt) return false;
      const batch = await tx.batches.get(execution.period, execution.block);
      await tx.executions.save({ ...execution, finishedAt: now, result, stopReason });
      if (batch) {
        assertBatchTransition(batch.state, result);
        await tx.batches.save({ ...batch, state: result, stopReason, updatedAt: now });
      }
      await tx.outbox.add(
        domainEvent(newId, 'EXECUTION_FINISHED', now, { executionId: execution.executionId, result, stopReason, counters: counters.snapshot() }),
      );
      if (stopReason) {
        await raiseAlert(tx, newId, {
          alertId: newId(),
          type: 'BATCH_STOPPED',
          subject: execution.executionId,
          detail: `${execution.period.toString()}/${execution.block} stopped: ${stopReason}`,
          raisedAt: now,
        });
      }
      if (result === 'COMPLETED') {
        // Files are discarded once the batch is processed (D4). FAILED receipts need them uploaded again (A2).
        for (const receipt of await tx.receipts.listByBatch(execution.period, execution.block)) {
          if (receipt.fileAvailable) await tx.receipts.save({ ...receipt, fileAvailable: false, updatedAt: now });
        }
      }
      return true;
    });
    if (!finished) return;
    await this.progress.emit(execution.executionId, { type: 'FINISHED', batchState: result, stopReason, counters: counters.snapshot() });
    // After FINISHED: the execution is over even if the volume fails here (D32 does not undo a finished batch).
    if (result === 'COMPLETED') await fileStore.purgeBatch(execution.period, execution.block);
  }
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_CAUSE_LENGTH ? `${text.slice(0, MAX_CAUSE_LENGTH)}…` : text;
}
