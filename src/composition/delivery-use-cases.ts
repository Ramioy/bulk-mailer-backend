import { DeliveryFollowUps } from '../application/delivery/delivery-follow-ups';
import { GetWebhook, ListSuppressions, ListWebhooks } from '../application/delivery/delivery-queries';
import type { DeliveryDependencies } from '../application/delivery/delivery-dependencies';
import { ProcessDeliveryEvent, RecordDeliveryWebhook } from '../application/delivery/delivery-webhooks';
import { CheckRecentSends, ReconcileAttempt, SweepUnconfirmed } from '../application/delivery/reconciliation';
import { ReleaseSuppressedAddress } from '../application/delivery/release-suppressed-address';
import { ResendReceipt } from '../application/delivery/resend-receipt';
import { ResolveUncertain } from '../application/delivery/resolve-uncertain';
import { VerifyDelivery } from '../application/delivery/verify-delivery';

export interface DeliveryUseCases {
  readonly recordWebhook: RecordDeliveryWebhook;
  readonly processWebhook: ProcessDeliveryEvent;
  readonly reconcile: ReconcileAttempt;
  readonly sweep: SweepUnconfirmed;
  readonly recentSends: CheckRecentSends;
  readonly resolve: ResolveUncertain;
  readonly release: ReleaseSuppressedAddress;
  readonly resend: ResendReceipt;
  readonly verify: VerifyDelivery;
  readonly followUps: DeliveryFollowUps;
  readonly suppressions: ListSuppressions;
  readonly webhooks: ListWebhooks;
  readonly webhook: GetWebhook;
}

export function deliveryUseCases(deps: DeliveryDependencies): DeliveryUseCases {
  return {
    recordWebhook: new RecordDeliveryWebhook(deps),
    processWebhook: new ProcessDeliveryEvent(deps),
    reconcile: new ReconcileAttempt(deps),
    sweep: new SweepUnconfirmed(deps),
    recentSends: new CheckRecentSends(deps),
    resolve: new ResolveUncertain(deps),
    release: new ReleaseSuppressedAddress(deps),
    resend: new ResendReceipt(deps),
    verify: new VerifyDelivery(deps),
    followUps: new DeliveryFollowUps(deps),
    suppressions: new ListSuppressions(deps),
    webhooks: new ListWebhooks(deps),
    webhook: new GetWebhook(deps),
  };
}
