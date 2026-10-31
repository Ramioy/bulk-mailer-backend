import { normaliseEmail } from '../../domain/recipient/recipient';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import type { DeliveryDependencies } from './delivery-dependencies';

export interface ReleaseRequest {
  /** The business confirmed the address is valid (§10.3, step 1). */
  readonly businessConfirmed: boolean;
  /** Without a provider API (D19): the operator removed the address in the provider console. */
  readonly removedInProviderConsole: boolean;
  readonly note: string;
}

export type ReleaseError =
  | { readonly code: 'NOTE_REQUIRED' | 'BUSINESS_CONFIRMATION_REQUIRED' | 'PROVIDER_REMOVAL_NOT_CONFIRMED' | 'ADDRESS_NOT_SUPPRESSED' }
  /** The provider refused or failed: nothing is released (never on one side only). */
  | { readonly code: 'SUPPRESSION_PROVIDER_FAILED'; readonly detail: string };

/**
 * Release of a suppressed address: single, atomic and audited (§10.3). The address leaves the local list only after
 * the provider side is done (API confirmation or, with D19, the operator's confirmation of the console removal).
 */
export class ReleaseSuppressedAddress {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'suppressionManager' | 'clock' | 'newId' | 'serial'>) {}

  execute(operator: string, rawEmail: string, request: ReleaseRequest): Promise<Result<{ email: string; provider: string }, ReleaseError>> {
    return this.deps.serial.run(async () => {
      const { repository, suppressionManager, clock, newId } = this.deps;
      const email = normaliseEmail(rawEmail);
      const note = request.note.trim();
      if (note === '') return err({ code: 'NOTE_REQUIRED' });
      if (!request.businessConfirmed) return err({ code: 'BUSINESS_CONFIRMATION_REQUIRED' });
      if (suppressionManager.confirmation === 'OPERATOR' && !request.removedInProviderConsole) return err({ code: 'PROVIDER_REMOVAL_NOT_CONFIRMED' });
      const suppression = await repository.suppressions.get(email);
      if (!suppression) return err({ code: 'ADDRESS_NOT_SUPPRESSED' });

      const released = await suppressionManager.release(email);
      if (!released.ok) return err({ code: 'SUPPRESSION_PROVIDER_FAILED', detail: released.error });

      const now = clock.now();
      await repository.transaction(async (tx) => {
        await tx.suppressions.remove(email);
        await tx.audit.append({
          auditId: newId(),
          actor: operator,
          action: 'ADDRESS_RELEASED',
          at: now,
          subject: email,
          previousValue: suppression.reason,
          newValue: released.value,
          note,
        });
        await tx.outbox.add(domainEvent(newId, 'ADDRESS_RELEASED', now, { email, previousReason: suppression.reason, provider: released.value, by: operator }));
      });
      return ok({ email, provider: released.value });
    });
  }
}
