import { createHash } from 'node:crypto';

import type { Execution } from '../../domain/batch/batch';
import { assertBatchTransition } from '../../domain/batch/batch-state';
import type { ManifestEntry } from '../../domain/batch/manifest';
import { contractSourceOf } from '../../domain/block/block';
import type { Receipt } from '../../domain/receipt/receipt';
import { assertTransition } from '../../domain/receipt/receipt-state';
import { resolveRecipient } from '../../domain/recipient/recipient';
import type { Attempt } from '../../domain/sending/attempt';
import { ProviderIncidentTracker, SourceIncidentTracker } from '../../domain/sending/incident-policy';
import { resolveSendOutcome, type SendOutcome } from '../../domain/sending/send-outcome';
import { BatchStopReason, SendErrorType, type ReceiptErrorType } from '../../domain/shared/error-types';
import { raiseAlert } from '../alerts/raise-alert';
import { applyPendingEvents } from '../delivery/apply-delivery-event';
import { domainEvent } from '../events/domain-events';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { DomainEventType } from '../../ports/event-bus';
import { renderEmail } from './email-template';
import type { ExecutionDependencies } from './execution-dependencies';
import { Counters, ProgressRecorder } from './progress-recorder';
import { readyManifestEntries } from './ready-entries';

type Step = { readonly stop?: BatchStopReason };

/**
 * Processes one execution: its manifest receipts one at a time, with a pause between sends,
 * growing waits after uncertain responses and a stop after three consecutive incidents.
 * There are no automatic retries: a receipt is sent at most once per execution.
 */
export class RunExecution {
  private readonly progress: ProgressRecorder;

  constructor(private readonly deps: ExecutionDependencies) {
    this.progress = new ProgressRecorder(deps.repository, deps.progress, deps.clock);
  }

  async execute(executionId: string): Promise<void> {
    const { repository } = this.deps;
    const execution = await repository.executions.get(executionId);
    // Already finished (e.g. stopped as INTERRUPTED by crash recovery): nothing to do.
    if (!execution || execution.finishedAt) return;

    const manifest = await repository.batches.getManifest(execution.period, execution.block, execution.manifestVersion);
    const entries = manifest ? await readyManifestEntries(repository, manifest) : [];
    const counters = new Counters(entries.length);
    await this.progress.emit(executionId, { type: 'STARTED', counters: counters.snapshot() });

    const providerIncidents = new ProviderIncidentTracker(this.deps.incidentPolicy);
    const sourceIncidents = new SourceIncidentTracker(this.deps.incidentPolicy.stopAfter);

    for (const [index, entry] of entries.entries()) {
      if (index > 0) await this.deps.clock.sleep(this.deps.pauseBetweenSendsMs);
      const step = await this.sendOne(execution, entry, counters, providerIncidents, sourceIncidents);
      if (step.stop) return this.finish(execution, counters, step.stop);
    }
    return this.finish(execution, counters);
  }

  private async sendOne(
    execution: Execution,
    entry: ManifestEntry,
    counters: Counters,
    providerIncidents: ProviderIncidentTracker,
    sourceIncidents: SourceIncidentTracker,
  ): Promise<Step> {
    const { repository, fileStore, contractSources, emailProvider, clock, newId } = this.deps;
    const receipt = (await repository.receipts.get(entry.sha256)) as Receipt;

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
    assertTransition(receipt.state, 'SENDING');
    const sending: Receipt = { ...receipt, state: 'SENDING', attempts: receipt.attempts + 1, updatedAt: clock.now() };
    await this.write(async (tx) => {
      await tx.attempts.insert(attempt);
      await tx.receipts.save(sending);
      await tx.receipts.appendHistory({ sha256: entry.sha256, at: clock.now(), event: 'SENDING', detail: `attempt ${attempt.attemptId}` });
    });

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
      return sourceDecision.action === 'STOP' ? { stop: sourceDecision.reason } : step;
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
    const outcome = await emailProvider.send({
      attemptId: attempt.attemptId,
      to: entry.email,
      copyTo: execution.copyAddress,
      subject,
      textBody,
      attachment: { name: entry.fileName, content },
    });
    const resolution = resolveSendOutcome(outcome);
    await this.recordOutcome(execution, sending, attempt, outcome, counters, resolution.receiptState, resolution.errorType);
    if (resolution.stopBatch) return { stop: resolution.stopBatch };

    const decision = providerIncidents.register(outcome);
    if (decision.action === 'STOP') return { stop: decision.reason };
    if (decision.action === 'WAIT') {
      // Reported before the wait starts, so the operator knows the batch is waiting, not stuck.
      const nextSendAt = new Date(clock.now().getTime() + decision.seconds * 1000);
      await this.progress.emit(execution.executionId, {
        type: 'WAITING',
        reason: outcome.kind === 'ACCEPTED' ? outcome.kind : outcome.detail,
        seconds: decision.seconds,
        consecutiveIncidents: decision.consecutiveIncidents,
        nextSendAt: nextSendAt.toISOString(),
      });
      await clock.sleep(decision.seconds * 1000);
    }
    return {};
  }

  /**
   * Changes to receipts go through the serial executor in short sections: the execution itself runs outside it,
   * in parallel to the delivery lane (D21), and must not overwrite what that lane records.
   */
  private write(work: (tx: BulkMailerStores) => Promise<void>): Promise<void> {
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
    await this.write(async (tx) => {
      await tx.attempts.save({ ...attempt, finishedAt: now, detail: `not sent: ${errorType}${detail ? ` (${detail})` : ''}` });
      await tx.receipts.save(failed);
      await tx.receipts.appendHistory({ sha256: failed.sha256, at: now, event: 'FAILED', detail: errorType });
      await tx.outbox.add(this.receiptEvent('RECEIPT_SEND_FAILED', now, execution, attempt, { errorType, providerCalled: false }));
    });
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
  ): Promise<void> {
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
    await this.write(async (tx) => {
      await tx.attempts.save({
        ...attempt,
        finishedAt: now,
        outcome: outcome.kind,
        detail,
        providerRequestId: outcome.kind === 'ACCEPTED' ? outcome.providerRequestId : undefined,
      });
      await tx.receipts.save(updated);
      await tx.receipts.appendHistory({ sha256: updated.sha256, at: now, event: state, detail: detail ?? outcome.kind });
      const type: DomainEventType = state === 'SENT' ? 'RECEIPT_SENT' : state === 'UNCERTAIN' ? 'RECEIPT_UNCERTAIN' : 'RECEIPT_SEND_FAILED';
      await tx.outbox.add(this.receiptEvent(type, now, execution, attempt, { state, outcome: outcome.kind, errorType, providerCalled: true }));
      // Delivery events that arrived while it was SENDING (D21).
      if (state === 'SENT' || state === 'UNCERTAIN') await applyPendingEvents(tx, this.deps.newId, now, attempt.attemptId);
    });
    counters.record(state, errorType);
    await this.emitProcessed(execution, updated, counters);
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
    const { repository, fileStore, clock, newId } = this.deps;
    const now = clock.now();
    const result = stopReason ? 'STOPPED' : 'COMPLETED';
    const batch = await repository.batches.get(execution.period, execution.block);

    await this.write(async (tx) => {
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
    });
    if (result === 'COMPLETED') await fileStore.purgeBatch(execution.period, execution.block);

    await this.progress.emit(execution.executionId, { type: 'FINISHED', batchState: result, stopReason, counters: counters.snapshot() });
  }
}
