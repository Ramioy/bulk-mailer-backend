import { createHash } from 'node:crypto';

import { contractSourceOf } from '../../domain/block/block';
import type { Receipt } from '../../domain/receipt/receipt';
import { assertTransition, canResend } from '../../domain/receipt/receipt-state';
import type { Sha256 } from '../../domain/receipt/sha256';
import { resolveRecipient } from '../../domain/recipient/recipient';
import type { Attempt } from '../../domain/sending/attempt';
import { resolveSendOutcome } from '../../domain/sending/send-outcome';
import { RecipientErrorType, type RecipientErrorType as RecipientError } from '../../domain/shared/error-types';
import { err, ok, type Result } from '../../domain/shared/result';
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

/**
 * Resend (§10.4): manual, one receipt, only after a hard bounce or a complaint. The source is queried again; the
 * same address as the one that failed is blocked as EMAIL_SUPPRESSED unless it was released. A new attempt with a
 * new id; no automatic retry. A failed resend enters the next normal manifest (D7c). Audited.
 */
export class ResendReceipt {
  constructor(private readonly deps: DeliveryDependencies) {}

  execute(operator: string, sha256: Sha256): Promise<Result<ResendResult, ResendError>> {
    return this.deps.serial.run(() => this.run(operator, sha256));
  }

  private async run(operator: string, sha256: Sha256): Promise<Result<ResendResult, ResendError>> {
    const { repository, fileStore, contractSources, emailProvider, clock, newId } = this.deps;
    // While an execution runs, resend is disabled like every other batch command.
    if (await repository.executions.running()) return err('EXECUTION_IN_PROGRESS');
    const receipt = await repository.receipts.get(sha256);
    if (!receipt) return err('RECEIPT_NOT_FOUND');
    if (!canResend(receipt.state, receipt.deliveryState ?? 'UNCONFIRMED')) return err('RECEIPT_NOT_RESENDABLE');
    if (!receipt.fileAvailable) return err('FILE_NOT_AVAILABLE');
    const content = await fileStore.read({ period: receipt.period, block: receipt.block, sha256 });
    if (!content) return err('FILE_NOT_AVAILABLE');
    if (createHash('sha256').update(content).digest('hex') !== sha256) return err('FILE_MODIFIED');

    const resolved = resolveRecipient(await contractSources[contractSourceOf(receipt.block)].get(receipt.contract ?? ''), () => false);
    if (!resolved.ok) return err(resolved.error);
    const recipient = resolved.value;
    const attempts = await repository.attempts.listByReceipt(sha256);
    const previousEmail = attempts.at(-1)?.to ?? receipt.recipient?.email ?? '';
    // Same address as the one that failed: still suppressed unless released (§10.3). A new address may be suppressed too.
    if (await repository.suppressions.get(recipient.email)) return err(RecipientErrorType.EMAIL_SUPPRESSED);

    const copyEnabled = await repository.settings.archiveCopyEnabled();
    if (copyEnabled && !this.deps.archiveCopyAddress) return err('ARCHIVE_COPY_NOT_CONFIGURED');

    const attempt: Attempt = {
      attemptId: newId(),
      sha256,
      kind: 'RESEND',
      to: recipient.email,
      ...(copyEnabled ? { copyAddress: this.deps.archiveCopyAddress } : {}),
      startedAt: clock.now(),
    };
    assertTransition(receipt.state, 'SENDING');
    const sending: Receipt = { ...receipt, state: 'SENDING', recipient, deliveryState: undefined, attempts: receipt.attempts + 1, updatedAt: clock.now() };
    await repository.transaction(async (tx) => {
      await tx.attempts.insert(attempt);
      await tx.receipts.save(sending);
      await tx.receipts.appendHistory({ sha256, at: clock.now(), event: 'SENDING', detail: `resend, attempt ${attempt.attemptId}, by ${operator}` });
    });

    const concept = (await repository.concepts.list()).find((c) => c.key === receipt.conceptKey) ?? { subject: receipt.conceptKey ?? '' };
    const { subject, textBody } = renderEmail(this.deps.emailTemplate, { concept, period: receipt.period, complexName: recipient.complexName, fileName: receipt.fileName });
    const outcome = await emailProvider.send({
      attemptId: attempt.attemptId,
      to: recipient.email,
      copyTo: attempt.copyAddress,
      subject,
      textBody,
      attachment: { name: receipt.fileName, content },
    });
    const resolution = resolveSendOutcome(outcome);
    const state = resolution.receiptState;
    const detail = outcome.kind === 'ACCEPTED' ? undefined : outcome.detail;
    const now = clock.now();
    assertTransition('SENDING', state);
    const updated: Receipt = {
      ...sending,
      state,
      errorType: resolution.errorType,
      errorDetail: detail,
      ...(state === 'SENT' ? { deliveryState: 'UNCONFIRMED' as const, fileAvailable: false } : {}),
      updatedAt: now,
    };

    await repository.transaction(async (tx) => {
      await tx.attempts.save({
        ...attempt,
        finishedAt: now,
        outcome: outcome.kind,
        detail,
        providerRequestId: outcome.kind === 'ACCEPTED' ? outcome.providerRequestId : undefined,
      });
      await tx.receipts.save(updated);
      await tx.receipts.appendHistory({ sha256, at: now, event: state, detail: detail ?? outcome.kind });
      // A resend that did not go out enters the next normal manifest (D7c).
      if (state === 'FAILED' || state === 'PENDING') await publishNextManifest(tx, receipt.period, receipt.block, now);
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'RECEIPT_RESENT',
        at: now,
        subject: sha256,
        previousValue: previousEmail,
        newValue: recipient.email,
        note: `attempt ${attempt.attemptId}: ${state}${resolution.errorType ? ` / ${resolution.errorType}` : ''}`,
      });
      const type: DomainEventType = state === 'SENT' ? 'RECEIPT_SENT' : state === 'UNCERTAIN' ? 'RECEIPT_UNCERTAIN' : 'RECEIPT_SEND_FAILED';
      await tx.outbox.add(
        domainEvent(newId, type, now, { sha256, attemptId: attempt.attemptId, attemptKind: 'RESEND', state, outcome: outcome.kind, errorType: resolution.errorType, providerCalled: true }),
      );
      if (outcome.kind === 'UNKNOWN_REJECTION') await unknownRejectionAlert(tx, newId, now, updated, outcome.detail);
      if (state === 'SENT' || state === 'UNCERTAIN') await applyPendingEvents(tx, newId, now, attempt.attemptId);
    });
    // Files are kept only until the receipt is processed (D4).
    if (state === 'SENT') await fileStore.delete({ period: receipt.period, block: receipt.block, sha256 });
    return ok({ attemptId: attempt.attemptId, state, previousEmail, email: recipient.email });
  }
}

