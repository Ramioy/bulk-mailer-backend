import { createHash } from 'node:crypto';

import { contractSourceOf } from '../../domain/block/block';
import type { Receipt } from '../../domain/receipt/receipt';
import { assertTransition, canResend } from '../../domain/receipt/receipt-state';
import type { Sha256 } from '../../domain/receipt/sha256';
import { resolveRecipient, type Recipient } from '../../domain/recipient/recipient';
import type { Attempt } from '../../domain/sending/attempt';
import { resolveSendOutcome, type SendOutcome } from '../../domain/sending/send-outcome';
import { RecipientErrorType, type RecipientErrorType as RecipientError } from '../../domain/shared/error-types';
import { err, ok, type Result } from '../../domain/shared/result';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { DomainEventType } from '../../ports/event-bus';
import { domainEvent } from '../events/domain-events';
import { applyPendingEvents } from './apply-delivery-event';
import { publishNextManifest } from '../receipts/receipt-dependencies';
import { renderEmail } from '../sending/email-template';
import type { DeliveryDependencies } from './delivery-dependencies';
import { unknownRejectionAlert } from '../alerts/raise-alert';

export type ResendError =
  | 'EXECUTION_IN_PROGRESS'
  | 'RECEIPT_NOT_FOUND'
  /** Only after a hard bounce or a complaint (§10.4). */
  | 'RECEIPT_NOT_RESENDABLE'
  /** The file was purged: upload the same PDF again (A2). */
  | 'FILE_NOT_AVAILABLE'
  | 'FILE_MODIFIED'
  | 'ARCHIVE_COPY_NOT_CONFIGURED'
  /** The source could not be queried, or the contract has no usable email; or the address is still suppressed. */
  | RecipientError;

export interface ResendResult {
  readonly attemptId: string;
  readonly state: Receipt['state'];
  readonly previousEmail: string;
  readonly email: string;
}

interface Started {
  /** The receipt as it was before this resend (SENT, with its terminal delivery state). */
  readonly before: Receipt;
  readonly attempt: Attempt;
  readonly previousEmail: string;
}

/** Longest error text kept in histories. */
const MAX_CAUSE_LENGTH = 300;

/**
 * Resend (§10.4): manual, one receipt, only after a hard bounce or a complaint. The source is queried again; the
 * same address as the one that failed is blocked as EMAIL_SUPPRESSED unless it was released. A new attempt with a
 * new id; no automatic retry. A failed resend enters the next normal manifest (D7c). Audited.
 *
 * Like an execution (D36): the file, the contract lookup and the provider call happen outside the serial executor;
 * inside it, two short transactions: (1) every refusal again on the current state, the attempt and SENDING;
 * (3) the outcome. An exception between them releases the receipt (D32): UNCERTAIN if the provider may have been
 * called, otherwise back to SENT with its previous delivery state.
 */
export class ResendReceipt {
  constructor(private readonly deps: DeliveryDependencies) {}

  async execute(operator: string, sha256: Sha256): Promise<Result<ResendResult, ResendError>> {
    const { repository, fileStore, contractSources, emailProvider, serial } = this.deps;
    // Phase (a), outside the executor: refused at once when it is already clear, then the file and the source.
    if (await repository.executions.running()) return err('EXECUTION_IN_PROGRESS');
    const found = await repository.receipts.get(sha256);
    const early = refusal(found);
    if (early) return err(early);
    const receipt = found as Receipt;
    const content = await fileStore.read({ period: receipt.period, block: receipt.block, sha256 });
    if (!content) return err('FILE_NOT_AVAILABLE');
    if (createHash('sha256').update(content).digest('hex') !== sha256) return err('FILE_MODIFIED');
    const resolved = resolveRecipient(await contractSources[contractSourceOf(receipt.block)].get(receipt.contract ?? ''), () => false);
    if (!resolved.ok) return err(resolved.error);
    const recipient = resolved.value;

    // (1) Inside the executor: everything checked again on the current state; the attempt is recorded before the call.
    const started = await serial.run(() => repository.transaction((tx) => this.start(tx, operator, sha256, receipt, recipient)));
    if (!started.ok) return started;

    // (2) Outside: the provider call, at most once for this attempt (C2).
    let providerCalled = false;
    try {
      const concept = (await repository.concepts.list()).find((c) => c.key === receipt.conceptKey) ?? { subject: receipt.conceptKey ?? '' };
      const { subject, textBody } = renderEmail(this.deps.emailTemplate, { concept, period: receipt.period, complexName: recipient.complexName, fileName: receipt.fileName });
      providerCalled = true;
      const outcome = await emailProvider.send({
        attemptId: started.value.attempt.attemptId,
        to: recipient.email,
        copyTo: started.value.attempt.copyAddress,
        subject,
        textBody,
        attachment: { name: receipt.fileName, content },
      });
      // (3) Inside again: the outcome.
      const state = await serial.run(() => this.record(operator, started.value, recipient.email, outcome));
      return ok({ attemptId: started.value.attempt.attemptId, state, previousEmail: started.value.previousEmail, email: recipient.email });
    } catch (error) {
      await serial.run(() => this.release(started.value, providerCalled, error));
      throw error;
    }
  }

  private async start(tx: BulkMailerStores, operator: string, sha256: Sha256, checked: Receipt, recipient: Recipient): Promise<Result<Started, ResendError>> {
    const { clock, newId } = this.deps;
    // While an execution runs, resend is disabled like every other batch command.
    if (await tx.executions.running()) return err('EXECUTION_IN_PROGRESS');
    const receipt = await tx.receipts.get(sha256);
    const refused = refusal(receipt);
    if (refused) return err(refused);
    const current = receipt as Receipt;
    // The contract of a SENT receipt does not change; if it did, the recipient looked up would not be its own.
    if (current.contract !== checked.contract || current.block !== checked.block) return err('RECEIPT_NOT_RESENDABLE');
    // Same address as the one that failed: still suppressed unless released (§10.3). Read here, so a hard bounce
    // processed while the source was being queried is honoured. A new address may be suppressed too.
    if (await tx.suppressions.get(recipient.email)) return err(RecipientErrorType.EMAIL_SUPPRESSED);
    const copyEnabled = await tx.settings.archiveCopyEnabled();
    if (copyEnabled && !this.deps.archiveCopyAddress) return err('ARCHIVE_COPY_NOT_CONFIGURED');

    const previousEmail = (await tx.attempts.listByReceipt(sha256)).at(-1)?.to ?? current.recipient?.email ?? '';
    const attempt: Attempt = {
      attemptId: newId(),
      sha256,
      kind: 'RESEND',
      to: recipient.email,
      ...(copyEnabled ? { copyAddress: this.deps.archiveCopyAddress } : {}),
      startedAt: clock.now(),
    };
    assertTransition(current.state, 'SENDING');
    await tx.attempts.insert(attempt);
    await tx.receipts.save({ ...current, state: 'SENDING', recipient, deliveryState: undefined, attempts: current.attempts + 1, updatedAt: clock.now() });
    await tx.receipts.appendHistory({ sha256, at: clock.now(), event: 'SENDING', detail: `resend, attempt ${attempt.attemptId}, by ${operator}` });
    return ok({ before: current, attempt, previousEmail });
  }

  private async record(operator: string, started: Started, email: string, outcome: SendOutcome): Promise<Receipt['state']> {
    const { repository, fileStore, clock, newId } = this.deps;
    const { attempt, previousEmail } = started;
    const sha256 = attempt.sha256;
    const resolution = resolveSendOutcome(outcome);
    const state = resolution.receiptState;
    const detail = outcome.kind === 'ACCEPTED' ? undefined : outcome.detail;
    const updated = await repository.transaction(async (tx) => {
      const now = clock.now();
      const current = (await tx.receipts.get(sha256)) as Receipt;
      assertTransition(current.state, state);
      const changed: Receipt = {
        ...current,
        state,
        errorType: resolution.errorType,
        errorDetail: detail,
        ...(state === 'SENT' ? { deliveryState: 'UNCONFIRMED' as const, fileAvailable: false } : {}),
        updatedAt: now,
      };
      await tx.attempts.save({
        ...attempt,
        finishedAt: now,
        outcome: outcome.kind,
        detail,
        providerRequestId: outcome.kind === 'ACCEPTED' ? outcome.providerRequestId : undefined,
      });
      await tx.receipts.save(changed);
      await tx.receipts.appendHistory({ sha256, at: now, event: state, detail: detail ?? outcome.kind });
      // A resend that did not go out enters the next normal manifest (D7c).
      if (state === 'FAILED' || state === 'PENDING') await publishNextManifest(tx, current.period, current.block, now);
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'RECEIPT_RESENT',
        at: now,
        subject: sha256,
        previousValue: previousEmail,
        newValue: email,
        note: `attempt ${attempt.attemptId}: ${state}${resolution.errorType ? ` / ${resolution.errorType}` : ''}`,
      });
      const type: DomainEventType = state === 'SENT' ? 'RECEIPT_SENT' : state === 'UNCERTAIN' ? 'RECEIPT_UNCERTAIN' : 'RECEIPT_SEND_FAILED';
      await tx.outbox.add(
        domainEvent(newId, type, now, { sha256, attemptId: attempt.attemptId, attemptKind: 'RESEND', state, outcome: outcome.kind, errorType: resolution.errorType, providerCalled: true }),
      );
      if (outcome.kind === 'UNKNOWN_REJECTION') await unknownRejectionAlert(tx, newId, now, changed, outcome.detail);
      if (state === 'SENT' || state === 'UNCERTAIN') await applyPendingEvents(tx, newId, now, attempt.attemptId);
      return changed;
    });
    // Files are kept only until the receipt is processed (D4).
    if (state === 'SENT') await fileStore.delete({ period: updated.period, block: updated.block, sha256 });
    return state;
  }

  /**
   * D32 for a resend: the receipt left SENDING by an exception. If the provider may have been called it becomes
   * UNCERTAIN (reconciliation resolves it; never sent again blindly, C2). If it certainly was not, it goes back to SENT
   * with the delivery state and recipient it had, so the operator can resend it again. If this fails too, the error
   * propagates and the recovery at the next start turns it UNCERTAIN.
   */
  private async release(started: Started, providerCalled: boolean, error: unknown): Promise<void> {
    const { repository, clock, newId } = this.deps;
    const { attempt, before } = started;
    const cause = describeError(error);
    await repository.transaction(async (tx) => {
      const now = clock.now();
      const current = await tx.receipts.get(attempt.sha256);
      // Only if this attempt still holds it: the exception may have hit after its outcome was recorded.
      if (current?.state !== 'SENDING' || (await tx.attempts.listByReceipt(attempt.sha256)).at(-1)?.attemptId !== attempt.attemptId) return;
      if (providerCalled) {
        assertTransition(current.state, 'UNCERTAIN');
        await tx.attempts.save({ ...attempt, finishedAt: now, outcome: 'UNCERTAIN', detail: `internal error after calling the provider: ${cause}` });
        await tx.receipts.save({ ...current, state: 'UNCERTAIN', errorDetail: `internal error: ${cause}`, updatedAt: now });
        await tx.receipts.appendHistory({ sha256: attempt.sha256, at: now, event: 'UNCERTAIN', detail: `resend: internal error after calling the provider: ${cause}` });
        await tx.outbox.add(
          domainEvent(newId, 'RECEIPT_UNCERTAIN', now, { sha256: attempt.sha256, attemptId: attempt.attemptId, attemptKind: 'RESEND', reason: 'INTERNAL_ERROR', providerCalled: true }),
        );
        return;
      }
      assertTransition(current.state, 'SENT');
      await tx.attempts.save({ ...attempt, finishedAt: now, detail: `not sent: internal error (${cause})` });
      await tx.receipts.save({ ...current, state: 'SENT', recipient: before.recipient, deliveryState: before.deliveryState, updatedAt: now });
      await tx.receipts.appendHistory({
        sha256: attempt.sha256,
        at: now,
        event: 'SENT',
        detail: `resend not sent (internal error before calling the provider: ${cause}); back to SENT / ${before.deliveryState ?? 'UNCONFIRMED'}`,
      });
    });
  }
}

/** Refusals that depend only on the receipt; checked outside first, then again inside the executor. */
function refusal(receipt: Receipt | undefined): ResendError | undefined {
  if (!receipt) return 'RECEIPT_NOT_FOUND';
  if (!canResend(receipt.state, receipt.deliveryState ?? 'UNCONFIRMED')) return 'RECEIPT_NOT_RESENDABLE';
  if (!receipt.fileAvailable) return 'FILE_NOT_AVAILABLE';
  return undefined;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_CAUSE_LENGTH ? `${text.slice(0, MAX_CAUSE_LENGTH)}…` : text;
}
