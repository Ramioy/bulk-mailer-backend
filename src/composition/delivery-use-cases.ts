import { DeliveryFollowUps } from '../application/delivery/delivery-follow-ups';
import type { DeliveryDependencies } from '../application/delivery/delivery-dependencies';
import { ProcessDeliveryEvent, RecordDeliveryWebhook } from '../application/delivery/delivery-webhooks';
import { ReconcileAttempt, SweepUnconfirmed } from '../application/delivery/reconciliation';
import { ReleaseSuppressedAddress } from '../application/delivery/release-suppressed-address';
import { ResendReceipt } from '../application/delivery/resend-receipt';
import { ResolveUncertain } from '../application/delivery/resolve-uncertain';

export interface DeliveryUseCases {
  readonly recordWebhook: RecordDeliveryWebhook;
  readonly processWebhook: ProcessDeliveryEvent;
  readonly reconcile: ReconcileAttempt;
  readonly sweep: SweepUnconfirmed;
  readonly resolve: ResolveUncertain;
  readonly release: ReleaseSuppressedAddress;
  readonly resend: ResendReceipt;
  readonly followUps: DeliveryFollowUps;
}

export function deliveryUseCases(deps: DeliveryDependencies): DeliveryUseCases {
  return {
    recordWebhook: new RecordDeliveryWebhook(deps),
    processWebhook: new ProcessDeliveryEvent(deps),
    reconcile: new ReconcileAttempt(deps),
    sweep: new SweepUnconfirmed(deps),
    resolve: new ResolveUncertain(deps),
    release: new ReleaseSuppressedAddress(deps),
    resend: new ResendReceipt(deps),
    followUps: new DeliveryFollowUps(deps),
  };
}
