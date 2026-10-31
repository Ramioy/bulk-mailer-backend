import type { DeliveryState } from '../../domain/receipt/delivery-state';
import type { Receipt } from '../../domain/receipt/receipt';
import type { Attempt } from '../../domain/sending/attempt';
import { SendErrorType } from '../../domain/shared/error-types';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { ProviderSendStatus } from '../../ports/send-lookup';
import { raiseAlert } from '../alerts/raise-alert';
import { domainEvent } from '../events/domain-events';
import { applyIncomingEvent, confirmSent, latestAttempt } from './apply-delivery-event';
import type { DeliveryDependencies } from './delivery-dependencies';

/** Delivery state shown by a status of the provider logs; QUEUED and PROCESSED only prove the send. */
const DELIVERY_BY_STATUS: Partial<Record<ProviderSendStatus, Exclude<DeliveryState, 'UNCONFIRMED'>>> = {
  DELIVERED: 'ACCEPTED',
  SOFT_BOUNCE: 'SOFT_BOUNCE',
  HARD_BOUNCE: 'HARD_BOUNCE',
};

export type ReconcileResult = 'ALREADY_RESOLVED' | 'SENT' | 'FAILED' | 'STILL_UNCERTAIN';

/**
 * ReconcileSends for one UNCERTAIN send (§9.4): looks it up in the provider logs at 5, 15 and 60 minutes.
 * Found → SENT (with its delivery state) or FAILED / PROVIDER_REJECTED when the provider failed to process it;
 * not found → FAILED / NOT_FOUND_AT_PROVIDER, but only at the last lookup; logs unavailable → stays UNCERTAIN.
 */
export class ReconcileAttempt {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'sendLookup' | 'clock' | 'newId'>) {}

  async execute(attemptId: string, final: boolean): Promise<ReconcileResult> {
    const { repository, sendLookup, clock, newId } = this.deps;
    const attempt = await repository.attempts.get(attemptId);
    const receipt = attempt && (await repository.receipts.get(attempt.sha256));
    if (!attempt || !receipt || receipt.state !== 'UNCERTAIN') return 'ALREADY_RESOLVED';
    if ((await latestAttempt(repository, receipt))?.attemptId !== attemptId) return 'ALREADY_RESOLVED';

    const found = await sendLookup.findByAttempt(attemptId, attempt.to);
    const now = clock.now();
    if (found.kind === 'UNAVAILABLE') {
      await repository.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'RECONCILIATION_UNAVAILABLE', detail: found.detail });
      return 'STILL_UNCERTAIN';
    }
    if (found.kind === 'NOT_FOUND') {
      if (!final) return 'STILL_UNCERTAIN';
      await repository.transaction((tx) => fail(tx, newId, now, receipt, attempt, SendErrorType.NOT_FOUND_AT_PROVIDER, 'not found in the provider logs'));
      return 'FAILED';
    }

    return repository.transaction(async (tx) => {
      const withIds = { ...attempt, providerRequestId: attempt.providerRequestId ?? found.providerRequestId, emailReference: attempt.emailReference ?? found.emailReference };
      await tx.attempts.save(withIds);
      if (found.status === 'PROCESS_FAILED') {
        await fail(tx, newId, now, receipt, withIds, SendErrorType.PROVIDER_REJECTED, found.detail ?? 'process failed at the provider');
        return 'FAILED';
      }
      const delivery = DELIVERY_BY_STATUS[found.status];
      if (delivery) {
        await applyIncomingEvent(tx, newId, now, logsEvent(withIds, delivery, now, found.detail));
      } else {
        await confirmSent(tx, newId, now, receipt, withIds, 'provider logs');
      }
      return 'SENT';
    });
  }
}

/**
 * Sweep of SENT receipts still UNCONFIRMED between N and 72 hours after the send, in case a webhook was lost, and
 * the WEBHOOKS_NOT_RECEIVED alert (§9.4), at most once per execution.
 */
export class SweepUnconfirmed {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'sendLookup' | 'clock' | 'newId' | 'reconciliation'>) {}

  async execute(): Promise<{ lookedUp: number; updated: number; alerts: number }> {
    const { repository, sendLookup, clock, newId, reconciliation } = this.deps;
    const now = clock.now();
    const from = new Date(now.getTime() - reconciliation.sweepMaxHours * 3_600_000);
    const to = new Date(now.getTime() - reconciliation.sweepAfterHours * 3_600_000);
    let lookedUp = 0;
    let updated = 0;
    let alerts = 0;

    for (const receipt of await repository.receipts.listByState('SENT')) {
      if (receipt.deliveryState !== 'UNCONFIRMED') continue;
      const attempt = await latestAttempt(repository, receipt);
      if (!attempt?.finishedAt || attempt.finishedAt < from || attempt.finishedAt > to) continue;
      lookedUp += 1;
      const found = await sendLookup.findByAttempt(attempt.attemptId, attempt.to);
      if (found.kind !== 'FOUND') continue;
      const delivery = DELIVERY_BY_STATUS[found.status];
      if (!delivery) {
        const known = (await repository.receipts.history(receipt.sha256)).some((h) => h.event === 'PROVIDER_PROCESS_FAILED');
        if (found.status === 'PROCESS_FAILED' && !known) {
          await repository.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'PROVIDER_PROCESS_FAILED', detail: found.detail ?? 'process failed after acceptance' });
        }
        continue;
      }
      const hadWebhook = (await repository.deliveryEvents.listByAttempt(attempt.attemptId)).some((e) => e.source === 'WEBHOOK');
      await repository.transaction(async (tx) => {
        const withIds = { ...attempt, emailReference: attempt.emailReference ?? found.emailReference };
        if (await applyIncomingEvent(tx, newId, now, logsEvent(withIds, delivery, now, found.detail)) === 'APPLIED') updated += 1;
        // Proven loss: the logs know a delivery state that no webhook reported.
        if (!hadWebhook && (await alertOnce(tx, newId, now, attempt.executionId ?? attempt.attemptId, `the provider logs show ${found.status} for ${receipt.fileName} but no webhook arrived`))) {
          alerts += 1;
        }
      });
    }

    // Total silence: an execution with sent receipts and, N hours later, no webhook for any of them.
    for (const execution of await repository.executions.listFinishedBetween(from, to)) {
      const sent = (await repository.attempts.listByExecution(execution.executionId)).filter((a) => a.outcome === 'ACCEPTED');
      if (sent.length === 0) continue;
      let anyWebhook = false;
      for (const attempt of sent) {
        if ((await repository.deliveryEvents.listByAttempt(attempt.attemptId)).some((e) => e.source === 'WEBHOOK')) {
          anyWebhook = true;
          break;
        }
      }
      if (anyWebhook) continue;
      const raised = await repository.transaction((tx) =>
        alertOnce(tx, newId, now, execution.executionId, `${sent.length} receipt(s) sent by ${execution.period.toString()}/${execution.block} and no webhook in ${reconciliation.sweepAfterHours} h`),
      );
      if (raised) alerts += 1;
    }
    return { lookedUp, updated, alerts };
  }
}

async function alertOnce(tx: BulkMailerStores, newId: () => string, now: Date, subject: string, detail: string): Promise<boolean> {
  if ((await tx.alerts.list()).some((a) => a.type === 'WEBHOOKS_NOT_RECEIVED' && a.subject === subject)) return false;
  await raiseAlert(tx, newId, {
    alertId: newId(),
    type: 'WEBHOOKS_NOT_RECEIVED',
    subject,
    detail: `${detail}. Check the endpoint and the webhook configuration in ZeptoMail.`,
    raisedAt: now,
  });
  return true;
}

/** The delivery state learnt from the logs, as an event with a stable id (a later sweep does not repeat it). */
function logsEvent(attempt: Attempt, state: Exclude<DeliveryState, 'UNCONFIRMED'>, now: Date, reason?: string) {
  return {
    eventId: `logs:${attempt.attemptId}:${state}`,
    attemptId: attempt.attemptId,
    recipient: attempt.to,
    state,
    reason,
    occurredAt: now,
    source: 'LOGS' as const,
    providerRequestId: attempt.providerRequestId,
    emailReference: attempt.emailReference,
  };
}

async function fail(
  tx: BulkMailerStores,
  newId: () => string,
  now: Date,
  receipt: Receipt,
  attempt: Attempt,
  errorType: SendErrorType,
  detail: string,
): Promise<void> {
  await tx.receipts.save({ ...receipt, state: 'FAILED', errorType, errorDetail: detail, updatedAt: now });
  await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'FAILED', detail: `${errorType} (reconciliation of attempt ${attempt.attemptId})` });
  await tx.outbox.add(domainEvent(newId, 'RECEIPT_RESOLVED', now, { sha256: receipt.sha256, attemptId: attempt.attemptId, state: 'FAILED', errorType, by: 'provider logs' }));
}
