import type { DeliveryState } from '../../domain/receipt/delivery-state';
import type { Receipt } from '../../domain/receipt/receipt';
import type { Attempt } from '../../domain/sending/attempt';
import { SendErrorType } from '../../domain/shared/error-types';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { ProviderSendStatus } from '../../ports/send-lookup';
import { raiseAlert } from '../alerts/raise-alert';
import { domainEvent } from '../events/domain-events';
import { awaitsLateEvidence } from '../../domain/receipt/receipt-state';
import { applyIncomingEvent, applyPendingEvents, confirmLateSent, confirmSent, latestAttempt } from './apply-delivery-event';
import type { DeliveryDependencies } from './delivery-dependencies';

type CheckDependencies = Pick<DeliveryDependencies, 'repository' | 'sendLookup' | 'clock' | 'newId' | 'serial'>;

/** Delivery state shown by a status of the provider logs; QUEUED and PROCESSED only prove the send. */
const DELIVERY_BY_STATUS: Partial<Record<ProviderSendStatus, Exclude<DeliveryState, 'UNCONFIRMED'>>> = {
  DELIVERED: 'ACCEPTED',
  SOFT_BOUNCE: 'SOFT_BOUNCE',
  HARD_BOUNCE: 'HARD_BOUNCE',
};

/** Receipts whose delivery can still change: worth looking up. */
export function isPendingDelivery(receipt: Receipt): boolean {
  return receipt.state === 'UNCERTAIN' || (receipt.state === 'SENT' && (receipt.deliveryState === 'UNCONFIRMED' || receipt.deliveryState === 'SOFT_BOUNCE'));
}

/**
 * Receipts worth looking up for `options`: pending delivery always; with `lateEvidence` (manual verification only, D34)
 * also a send failed as not found, in case it did go out after all.
 */
export function isCheckable(receipt: Receipt, options: CheckOptions = {}): boolean {
  return isPendingDelivery(receipt) || (options.lateEvidence === true && awaitsLateEvidence(receipt.state, receipt.errorType));
}

export interface CheckOptions {
  /** D34: also look up a FAILED / NOT_FOUND_AT_PROVIDER receipt. Not for the automatic checks (no new schedule). */
  readonly lateEvidence?: boolean;
}

export type CheckResult =
  /** The receipt changed: an UNCERTAIN one confirmed or failed, or a new delivery state. */
  | 'UPDATED'
  /** Found, nothing new. */
  | 'NO_CHANGE'
  | 'NOT_FOUND'
  /** The logs API could not be read (or answered something undocumented). */
  | 'UNAVAILABLE'
  /** Not the latest attempt, or nothing to check any more. */
  | 'NOT_APPLICABLE';

export interface CheckOutcome {
  readonly result: CheckResult;
  readonly providerStatus?: ProviderSendStatus;
  readonly detail?: string;
}

/**
 * Looks one send up in the provider logs and applies what it shows (§9.4). Shared by the scheduled reconciliation,
 * the sweep, the per-minute check (D21) and the manual verification (D22). An UNCERTAIN send not found is only
 * failed when `final` (the last scheduled lookup). The lookup runs outside the serial executor; the change inside it,
 * on the receipt as it is then.
 */
export async function checkAttempt(deps: CheckDependencies, attemptId: string, final: boolean, options: CheckOptions = {}): Promise<CheckOutcome> {
  const { repository, sendLookup, clock, newId, serial } = deps;
  const attempt = await repository.attempts.get(attemptId);
  const receipt = attempt && (await repository.receipts.get(attempt.sha256));
  if (!attempt || !receipt || !isCheckable(receipt, options)) return { result: 'NOT_APPLICABLE' };
  if ((await latestAttempt(repository, receipt))?.attemptId !== attemptId) return { result: 'NOT_APPLICABLE' };

  const found = await sendLookup.findByAttempt(attemptId, attempt.to);
  return serial.run(() =>
    repository.transaction(async (tx): Promise<CheckOutcome> => {
      const now = clock.now();
      // Events recorded while the send was being recorded (D21) come first.
      await applyPendingEvents(tx, newId, now, attemptId);
      const current = await tx.receipts.get(attempt.sha256);
      if (!current || !isCheckable(current, options)) return { result: 'UPDATED' };

      if (found.kind === 'UNAVAILABLE') {
        if (current.state === 'UNCERTAIN') await tx.receipts.appendHistory({ sha256: current.sha256, at: now, event: 'RECONCILIATION_UNAVAILABLE', detail: found.detail });
        return { result: 'UNAVAILABLE', detail: found.detail };
      }
      if (found.kind === 'NOT_FOUND') {
        if (current.state !== 'UNCERTAIN' || !final) return { result: 'NOT_FOUND' };
        await fail(tx, newId, now, current, attempt, SendErrorType.NOT_FOUND_AT_PROVIDER, 'not found in the provider logs');
        return { result: 'UPDATED', detail: 'not found in the provider logs' };
      }

      const withIds = { ...attempt, providerRequestId: attempt.providerRequestId ?? found.providerRequestId, emailReference: attempt.emailReference ?? found.emailReference };
      if (withIds.providerRequestId !== attempt.providerRequestId || withIds.emailReference !== attempt.emailReference) await tx.attempts.save(withIds);
      const status = found.status;
      if (status === 'PROCESS_FAILED') {
        if (current.state === 'UNCERTAIN') {
          await fail(tx, newId, now, current, withIds, SendErrorType.PROVIDER_REJECTED, found.detail ?? 'process failed at the provider');
          return { result: 'UPDATED', providerStatus: status };
        }
        // SENT and then not processed (M2): delivery PROCESS_FAILED, with an alert; the receipt can be resent.
        const applied = await applyIncomingEvent(tx, newId, now, logsEvent(withIds, 'PROCESS_FAILED', now, found.detail ?? 'process failed after acceptance'));
        return { result: applied === 'APPLIED' ? 'UPDATED' : 'NO_CHANGE', providerStatus: status };
      }
      const delivery = DELIVERY_BY_STATUS[status];
      if (delivery) {
        const applied = await applyIncomingEvent(tx, newId, now, logsEvent(withIds, delivery, now, found.detail));
        return { result: applied === 'APPLIED' ? 'UPDATED' : 'NO_CHANGE', providerStatus: status };
      }
      if (current.state === 'UNCERTAIN') {
        await confirmSent(tx, newId, now, current, withIds, 'provider logs');
        return { result: 'UPDATED', providerStatus: status };
      }
      if (awaitsLateEvidence(current.state, current.errorType)) {
        await confirmLateSent(tx, newId, now, current, withIds, 'provider logs', status);
        return { result: 'UPDATED', providerStatus: status };
      }
      return { result: 'NO_CHANGE', providerStatus: status };
    }),
  );
}

export type ReconcileResult = 'ALREADY_RESOLVED' | 'SENT' | 'FAILED' | 'STILL_UNCERTAIN';

/**
 * ReconcileSends for one UNCERTAIN send (§9.4): looked up at 5, 15 and 60 minutes. Found → SENT (with its delivery
 * state) or FAILED / PROVIDER_REJECTED when the provider failed to process it; not found → FAILED /
 * NOT_FOUND_AT_PROVIDER, but only at the last lookup; logs unavailable → stays UNCERTAIN.
 */
export class ReconcileAttempt {
  constructor(private readonly deps: CheckDependencies) {}

  async execute(attemptId: string, final: boolean): Promise<ReconcileResult> {
    const attempt = await this.deps.repository.attempts.get(attemptId);
    const before = attempt && (await this.deps.repository.receipts.get(attempt.sha256));
    if (!attempt || before?.state !== 'UNCERTAIN') return 'ALREADY_RESOLVED';
    const { result } = await checkAttempt(this.deps, attemptId, final);
    if (result === 'NOT_APPLICABLE') return 'ALREADY_RESOLVED';
    const after = await this.deps.repository.receipts.get(attempt.sha256);
    if (after?.state === 'SENT') return 'SENT';
    if (after?.state === 'FAILED') return 'FAILED';
    return 'STILL_UNCERTAIN';
  }
}

/**
 * Every minute while an execution runs and `recentCheckTailMinutes` after it (D21): the sends of those executions
 * whose delivery can still change are looked up. No alert here: WEBHOOKS_NOT_RECEIVED is judged after N hours.
 */
export class CheckRecentSends {
  constructor(private readonly deps: CheckDependencies & Pick<DeliveryDependencies, 'reconciliation'>) {}

  /** True while there is something to follow: an execution running or finished within the tail. */
  async active(): Promise<boolean> {
    return (await this.executions()).length > 0;
  }

  async execute(): Promise<{ checked: number; updated: number }> {
    let checked = 0;
    let updated = 0;
    for (const execution of await this.executions()) {
      for (const attempt of await this.deps.repository.attempts.listByExecution(execution.executionId)) {
        const { result } = await checkAttempt(this.deps, attempt.attemptId, false);
        if (result === 'NOT_APPLICABLE') continue;
        checked += 1;
        if (result === 'UPDATED') updated += 1;
      }
    }
    return { checked, updated };
  }

  private async executions() {
    const { repository, clock, reconciliation } = this.deps;
    const now = clock.now();
    const recent = await repository.executions.listFinishedBetween(new Date(now.getTime() - reconciliation.recentCheckTailMinutes * 60_000), now);
    const running = await repository.executions.running();
    return running ? [...recent, running] : recent;
  }
}

/**
 * Sweep of SENT receipts still UNCONFIRMED between N and 72 hours after the send, in case a webhook was lost, and
 * the WEBHOOKS_NOT_RECEIVED alert (§9.4), at most once per execution: proven loss (the logs know a delivery state
 * no webhook reported) or total silence (no webhook for any send), judged N hours after the execution.
 */
export class SweepUnconfirmed {
  constructor(private readonly deps: CheckDependencies & Pick<DeliveryDependencies, 'reconciliation'>) {}

  async execute(): Promise<{ lookedUp: number; updated: number; alerts: number }> {
    const { repository, clock, newId, serial, reconciliation } = this.deps;
    const now = clock.now();
    const from = new Date(now.getTime() - reconciliation.sweepMaxHours * 3_600_000);
    const to = new Date(now.getTime() - reconciliation.sweepAfterHours * 3_600_000);
    let lookedUp = 0;
    let updated = 0;
    let alerts = 0;
    const raise = async (subject: string, detail: string) => {
      if (await serial.run(() => repository.transaction((tx) => alertOnce(tx, newId, clock.now(), subject, detail)))) alerts += 1;
    };
    const webhookArrived = async (attemptId: string) => (await repository.deliveryEvents.listByAttempt(attemptId)).some((e) => e.source === 'WEBHOOK');

    for (const receipt of await repository.receipts.listByState('SENT')) {
      if (receipt.deliveryState !== 'UNCONFIRMED') continue;
      const attempt = await latestAttempt(repository, receipt);
      if (!attempt?.finishedAt || attempt.finishedAt < from || attempt.finishedAt > to) continue;
      lookedUp += 1;
      const { result, providerStatus } = await checkAttempt(this.deps, attempt.attemptId, false);
      if (result !== 'UPDATED') continue;
      updated += 1;
      // A resend has no execution: its proven loss is judged here. ZeptoMail has no webhook for a process failure.
      if (!attempt.executionId && providerStatus !== 'PROCESS_FAILED' && !(await webhookArrived(attempt.attemptId))) {
        await raise(attempt.attemptId, `the provider logs show ${providerStatus ?? 'a delivery state'} for ${receipt.fileName} but no webhook arrived`);
      }
    }

    for (const execution of await repository.executions.listFinishedBetween(from, to)) {
      const sent = (await repository.attempts.listByExecution(execution.executionId)).filter((a) => a.outcome === 'ACCEPTED' || a.outcome === 'UNCERTAIN');
      if (sent.length === 0) continue;
      let withWebhook = 0;
      let provenLoss = 0;
      let expectingWebhook = 0;
      for (const attempt of sent) {
        const events = await repository.deliveryEvents.listByAttempt(attempt.attemptId);
        // A process failure is only in the logs: ZeptoMail sends no webhook for it, so it proves nothing (M2).
        if (events.some((e) => e.state === 'PROCESS_FAILED')) continue;
        expectingWebhook += 1;
        if (events.some((e) => e.source === 'WEBHOOK')) withWebhook += 1;
        else if (events.some((e) => e.source === 'LOGS')) provenLoss += 1;
      }
      const where = `${execution.period.toString()}/${execution.block}`;
      if (provenLoss > 0) await raise(execution.executionId, `the provider logs show a delivery state for ${provenLoss} receipt(s) of ${where} but no webhook arrived`);
      else if (expectingWebhook > 0 && withWebhook === 0) await raise(execution.executionId, `${expectingWebhook} receipt(s) sent by ${where} and no webhook in ${reconciliation.sweepAfterHours} h`);
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

/** The delivery state learnt from the logs, as an event with a stable id (a later lookup does not repeat it). */
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
