import type { DeliveryState } from '../../domain/receipt/delivery-state';
import type { Receipt } from '../../domain/receipt/receipt';
import type { Attempt } from '../../domain/sending/attempt';
import { SendErrorType } from '../../domain/shared/error-types';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { ProviderSendStatus } from '../../ports/send-lookup';
import { raiseAlert } from '../alerts/raise-alert';
import { resolveReceiptAlerts } from '../alerts/resolve-alerts';
import { settleBatchIfDone } from '../sending/batch-settlement';
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
    const { result, detail } = await checkAttempt(this.deps, attemptId, final);
    if (result === 'NOT_APPLICABLE') return 'ALREADY_RESOLVED';
    const after = await this.deps.repository.receipts.get(attempt.sha256);
    if (after?.state === 'SENT') return 'SENT';
    if (after?.state === 'FAILED') return 'FAILED';
    // D43: the last scheduled lookup could not resolve it (logs unavailable…): no other lookup is scheduled, so the
    // operator is told, once per attempt. The hourly sweep keeps looking it up without ever failing it.
    if (final && after?.state === 'UNCERTAIN') await this.unresolved(after, attempt, result === 'UNAVAILABLE' ? `the logs API was unavailable (${detail ?? 'no detail'})` : `last lookup: ${result}`);
    return 'STILL_UNCERTAIN';
  }

  private async unresolved(receipt: Receipt, attempt: Attempt, reason: string): Promise<void> {
    const { repository, clock, newId, serial } = this.deps;
    await serial.run(() =>
      repository.transaction(async (tx) => {
        if ((await tx.alerts.list({ type: 'UNCERTAIN_UNRESOLVED', subject: receipt.sha256, reference: attempt.attemptId, limit: 1 })).length > 0) return;
        await raiseAlert(tx, newId, {
          alertId: newId(),
          type: 'UNCERTAIN_UNRESOLVED',
          subject: receipt.sha256,
          reference: attempt.attemptId,
          detail:
            `${receipt.fileName}: attempt ${attempt.attemptId} is still UNCERTAIN after its last scheduled lookup; ${reason}. ` +
            'The hourly sweep keeps looking it up for 72 h without failing it; meanwhile check it with ' +
            `POST /receipts/${receipt.sha256}/verify-delivery or resolve it with POST /receipts/${receipt.sha256}/resolve.`,
          raisedAt: clock.now(),
        });
      }),
    );
  }
}

/**
 * Every minute while an execution runs and `recentCheckTailMinutes` after it (D21): the sends of those executions
 * whose delivery can still change are looked up. No alert here: WEBHOOKS_NOT_RECEIVED is judged after N hours.
 *
 * D38: at most `recentCheckBatchSize` lookups per check, the sends looked up longest ago first, so a slow logs API or
 * a large batch cannot turn one check into hundreds of calls; a send whose lookup found the logs API unavailable is
 * skipped for `recentCheckBackoffCycles` checks. That rotation is kept in this object: a restart only resets it to
 * "oldest send first", which is fair too.
 */
export class CheckRecentSends {
  private cycle = 0;
  /** Cycle in which each send was last looked up. */
  private readonly lastChecked = new Map<string, number>();
  /** Last cycle in which each send is skipped after an unavailable lookup. */
  private readonly skipUntil = new Map<string, number>();

  constructor(private readonly deps: CheckDependencies & Pick<DeliveryDependencies, 'reconciliation'>) {}

  /** True while there is something to follow: an execution running or finished within the tail. */
  async active(): Promise<boolean> {
    return (await this.executions()).length > 0;
  }

  async execute(): Promise<{ checked: number; updated: number }> {
    const { repository, reconciliation } = this.deps;
    this.cycle += 1;
    const seen = new Set<string>();
    const candidates: Attempt[] = [];
    for (const execution of await this.executions()) {
      for (const attempt of await repository.attempts.listByExecution(execution.executionId)) {
        if (!(await needsLookup(repository, attempt))) continue;
        seen.add(attempt.attemptId);
        if ((this.skipUntil.get(attempt.attemptId) ?? 0) >= this.cycle) continue;
        candidates.push(attempt);
      }
    }
    // Forget sends that need no lookup any more, so the maps do not grow.
    for (const map of [this.lastChecked, this.skipUntil]) for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
    // Stable sort: never checked first, then by cycle; among equals, in send order.
    candidates.sort((a, b) => (this.lastChecked.get(a.attemptId) ?? 0) - (this.lastChecked.get(b.attemptId) ?? 0));

    let checked = 0;
    let updated = 0;
    for (const attempt of candidates.slice(0, reconciliation.recentCheckBatchSize)) {
      this.lastChecked.set(attempt.attemptId, this.cycle);
      const { result } = await checkAttempt(this.deps, attempt.attemptId, false);
      if (result === 'NOT_APPLICABLE') continue;
      checked += 1;
      if (result === 'UPDATED') updated += 1;
      if (result === 'UNAVAILABLE') this.skipUntil.set(attempt.attemptId, this.cycle + reconciliation.recentCheckBackoffCycles);
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

/** Without calling anyone: the latest attempt of a receipt whose delivery can still change. */
async function needsLookup(stores: Pick<BulkMailerStores, 'receipts' | 'attempts'>, attempt: Attempt): Promise<boolean> {
  const receipt = await stores.receipts.get(attempt.sha256);
  if (!receipt || !isPendingDelivery(receipt)) return false;
  return (await latestAttempt(stores, receipt))?.attemptId === attempt.attemptId;
}

/**
 * Hourly sweep (§9.4) of the sends whose delivery is still pending, in case a webhook was lost:
 * - SENT receipts UNCONFIRMED or SOFT_BOUNCE (D44: a hard bounce whose webhook was lost must be seen and suppressed)
 *   between N and 72 hours after the send;
 * - UNCERTAIN receipts whose last scheduled lookup is over (D43), up to 72 hours, never failed here.
 * At most `sweepBatchSize` lookups per run: those not looked up for the longest first, then the oldest sends (D44). Beyond 72 h a pending receipt is only visible in the
 * batch summary and in its alert.
 * Then the WEBHOOKS_NOT_RECEIVED alert, at most once per execution: proven loss (the logs know a delivery state no
 * webhook reported) or total silence (no webhook for any send that should have one), judged N hours after it.
 */
export class SweepUnconfirmed {
  private run = 0;
  /** Run in which each send was last looked up by the sweep (D44, as D38: a restart only resets the rotation). */
  private readonly lastSwept = new Map<string, number>();

  constructor(private readonly deps: CheckDependencies & Pick<DeliveryDependencies, 'reconciliation'>) {}

  async execute(): Promise<{ lookedUp: number; updated: number; alerts: number }> {
    const { repository, clock, newId, serial, reconciliation } = this.deps;
    const now = clock.now();
    this.run += 1;
    const from = new Date(now.getTime() - reconciliation.sweepMaxHours * 3_600_000);
    const to = new Date(now.getTime() - reconciliation.sweepAfterHours * 3_600_000);
    const afterLastLookup = new Date(now.getTime() - (reconciliation.uncertainDelaysMinutes.at(-1) ?? 0) * 60_000);
    let lookedUp = 0;
    let updated = 0;
    let alerts = 0;
    const raise = async (subject: string, detail: string) => {
      if (await serial.run(() => repository.transaction((tx) => alertOnce(tx, newId, clock.now(), subject, detail)))) alerts += 1;
    };
    const webhookArrived = async (attemptId: string) => (await repository.deliveryEvents.listByAttempt(attemptId)).some((e) => e.source === 'WEBHOOK');

    const candidates: Array<{ receipt: Receipt; attempt: Attempt; since: Date }> = [];
    // D50: only receipts updated within the window can have their latest send in it (a send updates its receipt).
    const pending = await repository.receipts.listPendingDeliveriesSince(from);
    for (const receipt of pending) {
      if (receipt.state !== 'SENT' || !isPendingDelivery(receipt)) continue;
      const attempt = await latestAttempt(repository, receipt);
      if (!attempt?.finishedAt || attempt.finishedAt < from || attempt.finishedAt > to) continue;
      candidates.push({ receipt, attempt, since: attempt.finishedAt });
    }
    for (const receipt of pending) {
      if (receipt.state !== 'UNCERTAIN') continue;
      const attempt = await latestAttempt(repository, receipt);
      // A send left UNCERTAIN by a crash has no finish time: its start counts.
      const since = attempt?.finishedAt ?? attempt?.startedAt;
      if (!attempt || !since || since < from || since > afterLastLookup) continue;
      candidates.push({ receipt, attempt, since });
    }
    // Not looked up for the longest first (never first), then the oldest send: the budget never starves anyone.
    const swept = (c: { attempt: Attempt }) => this.lastSwept.get(c.attempt.attemptId) ?? 0;
    candidates.sort((a, b) => swept(a) - swept(b) || a.since.getTime() - b.since.getTime());
    const inWindow = new Set(candidates.map((c) => c.attempt.attemptId));
    for (const id of this.lastSwept.keys()) if (!inWindow.has(id)) this.lastSwept.delete(id);

    for (const { receipt, attempt } of candidates.slice(0, reconciliation.sweepBatchSize)) {
      this.lastSwept.set(attempt.attemptId, this.run);
      lookedUp += 1;
      // Never final: an UNCERTAIN is never failed by the sweep (D43).
      const { result, providerStatus } = await checkAttempt(this.deps, attempt.attemptId, false);
      if (result !== 'UPDATED') continue;
      updated += 1;
      // A resend has no execution: its proven loss is judged here. ZeptoMail has no webhook for a process failure.
      if (receipt.state === 'SENT' && !attempt.executionId && providerStatus !== 'PROCESS_FAILED' && !(await webhookArrived(attempt.attemptId))) {
        await raise(attempt.attemptId, `the provider logs show ${providerStatus ?? 'a delivery state'} for ${receipt.fileName} but no webhook arrived`);
      }
    }

    for (const execution of await repository.executions.listFinishedBetween(from, to)) {
      const sent = (await repository.attempts.listByExecution(execution.executionId)).filter((a) => a.outcome === 'ACCEPTED' || a.outcome === 'UNCERTAIN');
      if (sent.length === 0) continue;
      let withWebhook = 0;
      let provenLoss = 0;
      let confirmedLate = 0;
      let expectingWebhook = 0;
      for (const attempt of sent) {
        // D44: only a send that went out expects a webhook: its receipt is SENT (or still UNCERTAIN) by this attempt.
        // One proven not sent (FAILED / NOT_FOUND_AT_PROVIDER), or replaced by a later attempt, expects none.
        const receipt = await repository.receipts.get(attempt.sha256);
        if (!receipt || (receipt.state !== 'SENT' && receipt.state !== 'UNCERTAIN')) continue;
        if ((await latestAttempt(repository, receipt))?.attemptId !== attempt.attemptId) continue;
        const events = await repository.deliveryEvents.listByAttempt(attempt.attemptId);
        // A process failure is only in the logs: ZeptoMail sends no webhook for it, so it proves nothing (M2).
        if (events.some((e) => e.state === 'PROCESS_FAILED')) continue;
        expectingWebhook += 1;
        if (events.some((e) => e.source === 'WEBHOOK')) withWebhook += 1;
        else if (events.some((e) => e.source === 'LOGS')) {
          provenLoss += 1;
          if ((await repository.receipts.history(receipt.sha256)).some((h) => h.detail?.startsWith('SENT confirmed late') && h.detail.includes(attempt.attemptId))) confirmedLate += 1;
        }
      }
      const where = `${execution.period.toString()}/${execution.block}`;
      if (provenLoss > 0) {
        const late = confirmedLate > 0 ? ` (${confirmedLate} of them first marked not sent and confirmed late, D34)` : '';
        await raise(execution.executionId, `the provider logs show a delivery state for ${provenLoss} receipt(s) of ${where}${late} but no webhook arrived`);
      } else if (expectingWebhook > 0 && withWebhook === 0) {
        // D45: "nothing arrived" and "webhooks arrived but could not be correlated" call for different checks.
        const unparsed = (await repository.alerts.list({ type: 'WEBHOOK_UNPARSED', since: execution.startedAt })).length;
        const silence =
          unparsed > 0
            ? `no webhook could be correlated in ${reconciliation.sweepAfterHours} h, although ${unparsed} webhook(s) arrived that could not be read (WEBHOOK_UNPARSED): check the payload format`
            : `no webhook arrived in ${reconciliation.sweepAfterHours} h`;
        await raise(execution.executionId, `${expectingWebhook} receipt(s) sent by ${where} and ${silence}`);
      }
    }
    return { lookedUp, updated, alerts };
  }
}

async function alertOnce(tx: BulkMailerStores, newId: () => string, now: Date, subject: string, detail: string): Promise<boolean> {
  if ((await tx.alerts.list({ type: 'WEBHOOKS_NOT_RECEIVED', subject, limit: 1 })).length > 0) return false;
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
  await resolveReceiptAlerts(tx, now, { sha256: receipt.sha256, from: receipt.state, to: 'FAILED', attempt });
  await tx.outbox.add(domainEvent(newId, 'RECEIPT_RESOLVED', now, { sha256: receipt.sha256, attemptId: attempt.attemptId, state: 'FAILED', errorType, by: 'provider logs' }));
  // The last UNCERTAIN of a stopped batch may have been this one (D41).
  await settleBatchIfDone(tx, newId, now, receipt.period, receipt.block);
}
