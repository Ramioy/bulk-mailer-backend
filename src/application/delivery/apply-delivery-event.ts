import type { Receipt } from '../../domain/receipt/receipt';
import { DomainError } from '../../domain/shared/domain-error';
import { applyDeliveryEvent, eventRecipientRole, type DeliveryEvent, type IncomingDeliveryEvent } from '../../domain/receipt/delivery-state';
import { assertTransition, awaitsLateEvidence } from '../../domain/receipt/receipt-state';
import type { Attempt } from '../../domain/sending/attempt';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import { raiseAlert } from '../alerts/raise-alert';
import { domainEvent } from '../events/domain-events';

export type ApplyResult =
  /** Same event id already recorded. */
  | 'DUPLICATE'
  /** No attempt with that client reference: recorded only. */
  | 'UNKNOWN_ATTEMPT'
  /** Recorded without changing the receipt (copy, unknown recipient, older attempt, no change). */
  | 'RECORDED'
  /** The send is still being recorded (SENDING): applied as soon as its outcome is (D21). */
  | 'PENDING_SEND'
  | 'APPLIED';

/** The most recent attempt of the receipt: only its events can change the receipt. */
export async function latestAttempt(stores: Pick<BulkMailerStores, 'attempts'>, receipt: Receipt): Promise<Attempt | undefined> {
  return (await stores.attempts.listByReceipt(receipt.sha256)).at(-1);
}

/**
 * The provider proved the email went out (a delivery event, or the logs): UNCERTAIN → SENT, delivery UNCONFIRMED.
 * Returns the updated receipt.
 */
export async function confirmSent(
  tx: BulkMailerStores,
  newId: () => string,
  now: Date,
  receipt: Receipt,
  attempt: Attempt,
  evidence: string,
): Promise<Receipt> {
  assertTransition(receipt.state, 'SENT');
  const sent: Receipt = { ...receipt, state: 'SENT', deliveryState: 'UNCONFIRMED', errorType: undefined, errorDetail: undefined, updatedAt: now };
  await tx.receipts.save(sent);
  await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'SENT', detail: `confirmed by ${evidence} (attempt ${attempt.attemptId})` });
  await tx.outbox.add(domainEvent(newId, 'RECEIPT_RESOLVED', now, { sha256: receipt.sha256, attemptId: attempt.attemptId, state: 'SENT', by: evidence }));
  return sent;
}

/**
 * D34: late evidence that a send failed as NOT_FOUND_AT_PROVIDER did go out: FAILED → SENT, delivery UNCONFIRMED
 * (the caller then applies the event's delivery state), with the LATE_SEND_EVIDENCE alert. Returns the updated receipt.
 */
export async function confirmLateSent(
  tx: BulkMailerStores,
  newId: () => string,
  now: Date,
  receipt: Receipt,
  attempt: Attempt,
  evidence: string,
  what: string,
): Promise<Receipt> {
  // FAILED → SENT is only for this case (D34): anything else is a bug, like any other forbidden transition.
  if (!awaitsLateEvidence(receipt.state, receipt.errorType)) throw new DomainError(`Receipt ${receipt.sha256} cannot be confirmed late from ${receipt.state}`);
  assertTransition(receipt.state, 'SENT');
  const failedAt = (await tx.receipts.history(receipt.sha256)).filter((h) => h.event === 'FAILED').at(-1)?.at ?? receipt.updatedAt;
  const sent: Receipt = { ...receipt, state: 'SENT', deliveryState: 'UNCONFIRMED', errorType: undefined, errorDetail: undefined, updatedAt: now };
  await tx.receipts.save(sent);
  await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'SENT', detail: `SENT confirmed late by ${evidence} (attempt ${attempt.attemptId})` });
  await tx.outbox.add(domainEvent(newId, 'RECEIPT_RESOLVED', now, { sha256: receipt.sha256, attemptId: attempt.attemptId, state: 'SENT', by: evidence, late: true }));
  await raiseAlert(tx, newId, {
    alertId: newId(),
    type: 'LATE_SEND_EVIDENCE',
    subject: receipt.sha256,
    detail:
      `${receipt.fileName}: attempt ${attempt.attemptId} to ${attempt.to}, marked FAILED / NOT_FOUND_AT_PROVIDER at ${failedAt.toISOString()}, ` +
      `did go out: ${what} from the ${evidence}. It is SENT now; if it was sent again meanwhile, the client received it twice.`,
    raisedAt: now,
  });
  return sent;
}

/** A process failure (M2, logs only) says the provider did not deliver it: it is no proof that the email went out. */
function provesSending(event: DeliveryEvent): boolean {
  return event.state !== 'PROCESS_FAILED';
}

/**
 * Records a delivery event and applies it to the receipt (§10, §12.5): only the primary recipient's events of the
 * latest attempt count; the delivery state only advances; a hard bounce or a complaint suppresses the address and
 * raises an alert; a bounce of the archive copy only raises an alert. Must run inside a transaction.
 */
export async function applyIncomingEvent(tx: BulkMailerStores, newId: () => string, now: Date, incoming: IncomingDeliveryEvent): Promise<ApplyResult> {
  const attempt = await tx.attempts.get(incoming.attemptId);
  const role = attempt ? eventRecipientRole(attempt, incoming.recipient) : 'UNKNOWN';
  const event: DeliveryEvent = { ...incoming, recipient: incoming.recipient ?? '', isPrimaryRecipient: role === 'PRIMARY' };
  if (!(await tx.deliveryEvents.record(event))) return 'DUPLICATE';
  if (!attempt) return 'UNKNOWN_ATTEMPT';

  if (role === 'COPY') {
    if (event.state === 'HARD_BOUNCE' || event.state === 'COMPLAINT') {
      await raiseAlert(tx, newId, {
        alertId: newId(),
        type: 'COPY_BOUNCED',
        subject: attempt.copyAddress ?? event.recipient,
        detail: `archive copy ${event.state} (attempt ${attempt.attemptId})${event.reason ? `: ${event.reason}` : ''}`,
        raisedAt: now,
      });
    }
    return 'RECORDED';
  }
  if (role === 'UNKNOWN') return 'RECORDED';

  return applyToReceipt(tx, newId, now, attempt, event);
}

/**
 * Events of the primary recipient recorded while the send was still SENDING (D21): applied once the outcome is
 * recorded. Also used by the recent-sends check for a receipt still UNCERTAIN or UNCONFIRMED with recorded events.
 */
export async function applyPendingEvents(tx: BulkMailerStores, newId: () => string, now: Date, attemptId: string): Promise<number> {
  const attempt = await tx.attempts.get(attemptId);
  if (!attempt) return 0;
  let applied = 0;
  for (const event of await tx.deliveryEvents.listByAttempt(attemptId)) {
    if (event.isPrimaryRecipient && (await applyToReceipt(tx, newId, now, attempt, event)) === 'APPLIED') applied += 1;
  }
  return applied;
}

async function applyToReceipt(tx: BulkMailerStores, newId: () => string, now: Date, attempt: Attempt, event: DeliveryEvent): Promise<ApplyResult> {
  let receipt = await tx.receipts.get(attempt.sha256);
  if (!receipt) return 'RECORDED';
  const attempts = await tx.attempts.listByReceipt(receipt.sha256);
  if (attempts.at(-1)?.attemptId !== attempt.attemptId) {
    await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'DELIVERY_EVENT_IGNORED', detail: `${event.state} of an older attempt ${attempt.attemptId}` });
    await detectDuplicateSend(tx, newId, now, receipt, attempts, attempt, event);
    return 'RECORDED';
  }

  if ((event.providerRequestId && !attempt.providerRequestId) || (event.emailReference && !attempt.emailReference)) {
    await tx.attempts.save({
      ...attempt,
      providerRequestId: attempt.providerRequestId ?? event.providerRequestId,
      emailReference: attempt.emailReference ?? event.emailReference,
    });
  }

  const evidence = event.source === 'WEBHOOK' ? 'delivery webhook' : 'provider logs';
  if (receipt.state === 'SENDING') return 'PENDING_SEND';
  if (receipt.state === 'UNCERTAIN') {
    receipt = await confirmSent(tx, newId, now, receipt, attempt, evidence);
  } else if (awaitsLateEvidence(receipt.state, receipt.errorType) && provesSending(event)) {
    receipt = await confirmLateSent(tx, newId, now, receipt, attempt, evidence, event.state);
  } else if (receipt.state !== 'SENT') {
    await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'DELIVERY_EVENT_IGNORED', detail: `${event.state} while ${receipt.state}` });
    return 'RECORDED';
  }

  const outcome = applyDeliveryEvent(receipt.deliveryState ?? 'UNCONFIRMED', event.state);
  if (outcome.kind === 'ANOMALY') {
    await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'DELIVERY_ANOMALY', detail: `${event.state} after ${outcome.state}` });
    return 'RECORDED';
  }
  if (outcome.kind === 'IGNORED') return 'RECORDED';

  await tx.receipts.save({ ...receipt, deliveryState: outcome.state, updatedAt: now });
  await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: `DELIVERY_${outcome.state}`, detail: event.reason });
  await tx.outbox.add(
    domainEvent(newId, 'DELIVERY_UPDATED', now, { sha256: receipt.sha256, attemptId: attempt.attemptId, deliveryState: outcome.state, source: event.source }),
  );
  if (outcome.state === 'HARD_BOUNCE' || outcome.state === 'COMPLAINT') {
    if (!(await tx.suppressions.get(attempt.to))) {
      await tx.suppressions.save({ email: attempt.to, reason: outcome.state, since: now, attemptId: attempt.attemptId });
      await tx.outbox.add(domainEvent(newId, 'ADDRESS_SUPPRESSED', now, { email: attempt.to, reason: outcome.state, attemptId: attempt.attemptId }));
    }
    await raiseAlert(tx, newId, {
      alertId: newId(),
      type: outcome.state,
      subject: receipt.sha256,
      detail: `${receipt.fileName}: ${attempt.to}${event.reason ? ` (${event.reason})` : ''}`,
      raisedAt: now,
    });
  }
  // M2: the provider did not process it; the address is not at fault, so it is not suppressed.
  if (outcome.state === 'PROCESS_FAILED') {
    await raiseAlert(tx, newId, {
      alertId: newId(),
      type: 'PROCESS_FAILED',
      subject: receipt.sha256,
      detail: `${receipt.fileName}: ${attempt.to} accepted but not processed by the provider${event.reason ? ` (${event.reason})` : ''}; it can be resent`,
      raisedAt: now,
    });
  }
  return 'APPLIED';
}

/**
 * D34: evidence that an older attempt went out, while a later attempt holds the receipt. If the older one was believed
 * not sent (the attempt right after it is a batch send, which only takes PENDING or FAILED receipts; after a send
 * that went out only a manual Resend follows), the client probably received the email twice. The state is kept;
 * the alert is raised once per older attempt.
 */
async function detectDuplicateSend(
  tx: BulkMailerStores,
  newId: () => string,
  now: Date,
  receipt: Receipt,
  attempts: readonly Attempt[],
  older: Attempt,
  event: DeliveryEvent,
): Promise<void> {
  if (!provesSending(event) || older.outcome === 'ACCEPTED') return;
  if (receipt.state !== 'SENDING' && receipt.state !== 'SENT' && receipt.state !== 'UNCERTAIN') return;
  const index = attempts.findIndex((a) => a.attemptId === older.attemptId);
  if (index < 0 || attempts[index + 1]?.kind !== 'BATCH') return;
  const latest = attempts.at(-1) as Attempt;
  const raised = (await tx.alerts.list()).some((a) => a.type === 'DUPLICATE_SEND_DETECTED' && a.subject === receipt.sha256 && a.detail.includes(older.attemptId));
  if (raised) return;
  await raiseAlert(tx, newId, {
    alertId: newId(),
    type: 'DUPLICATE_SEND_DETECTED',
    subject: receipt.sha256,
    detail:
      `${receipt.fileName}: attempt ${older.attemptId} to ${older.to}, believed not sent, did go out (${event.state} from the ` +
      `${event.source === 'WEBHOOK' ? 'delivery webhook' : 'provider logs'}); attempt ${latest.attemptId} to ${latest.to} is ${receipt.state}: ` +
      'the client probably received the email twice.',
    raisedAt: now,
  });
}
