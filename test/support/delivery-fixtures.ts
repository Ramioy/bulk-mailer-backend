import { FakeSendLookup } from '../../src/adapters/outbound/fakes/fake-send-lookup';
import { FakeSuppressionManager } from '../../src/adapters/outbound/fakes/fake-suppression-manager';
import { DeliveryFollowUps } from '../../src/application/delivery/delivery-follow-ups';
import { DEFAULT_RECONCILIATION_POLICY, type DeliveryDependencies } from '../../src/application/delivery/delivery-dependencies';
import { ProcessDeliveryEvent, RecordDeliveryWebhook } from '../../src/application/delivery/delivery-webhooks';
import { ReconcileAttempt, SweepUnconfirmed } from '../../src/application/delivery/reconciliation';
import { ReleaseSuppressedAddress } from '../../src/application/delivery/release-suppressed-address';
import { ResendReceipt } from '../../src/application/delivery/resend-receipt';
import { ResolveUncertain } from '../../src/application/delivery/resolve-uncertain';
import type { IncomingDeliveryEvent } from '../../src/domain/receipt/delivery-state';
import type { Receipt } from '../../src/domain/receipt/receipt';
import type { Attempt } from '../../src/domain/sending/attempt';
import type { ExecutionDependencies } from '../../src/application/sending/execution-dependencies';
import { OCT_2026 } from './builders';
import { executionFixture, type ExecutionFixture } from './execution-fixtures';

export interface DeliveryFixture extends ExecutionFixture {
  readonly lookup: FakeSendLookup;
  readonly suppressionManager: FakeSuppressionManager;
  readonly deliveryDeps: DeliveryDependencies;
  readonly followUps: DeliveryFollowUps;
  readonly recordWebhook: RecordDeliveryWebhook;
  readonly processWebhook: ProcessDeliveryEvent;
  readonly reconcile: ReconcileAttempt;
  readonly sweep: SweepUnconfirmed;
  readonly resolve: ResolveUncertain;
  readonly release: ReleaseSuppressedAddress;
  readonly resend: ResendReceipt;
  /** Uploads and sends one receipt; returns it with its attempt. */
  sendOne(): Promise<{ receipt: Receipt; attempt: Attempt }>;
  /** Stores a webhook with these events and processes it, as the job would. */
  deliver(webhookRequestId: string, ...events: Array<Partial<IncomingDeliveryEvent> & Pick<IncomingDeliveryEvent, 'attemptId' | 'state'>>): Promise<string[]>;
  receipt(sha256: string): Promise<Receipt>;
}

export function deliveryFixture(
  options: { readonly confirmation?: 'PROVIDER_API' | 'OPERATOR'; readonly execution?: Partial<ExecutionDependencies> } = {},
): DeliveryFixture {
  const fx = executionFixture(options.execution);
  const lookup = new FakeSendLookup();
  const suppressionManager = new FakeSuppressionManager(options.confirmation);
  const deliveryDeps: DeliveryDependencies = {
    repository: fx.repository,
    jobQueue: fx.jobs,
    sendLookup: lookup,
    suppressionManager,
    fileStore: fx.files,
    contractSources: fx.execDeps.contractSources,
    emailProvider: fx.email,
    clock: fx.clock,
    newId: fx.execDeps.newId,
    serial: fx.execDeps.serial,
    reconciliation: DEFAULT_RECONCILIATION_POLICY,
    emailTemplate: fx.execDeps.emailTemplate,
    archiveCopyAddress: fx.execDeps.archiveCopyAddress,
  };
  const recordWebhook = new RecordDeliveryWebhook(deliveryDeps);
  const processWebhook = new ProcessDeliveryEvent(deliveryDeps);
  let n = 0;
  return {
    ...fx,
    lookup,
    suppressionManager,
    deliveryDeps,
    followUps: new DeliveryFollowUps(deliveryDeps),
    recordWebhook,
    processWebhook,
    reconcile: new ReconcileAttempt(deliveryDeps),
    sweep: new SweepUnconfirmed(deliveryDeps),
    resolve: new ResolveUncertain(deliveryDeps),
    release: new ReleaseSuppressedAddress(deliveryDeps),
    resend: new ResendReceipt(deliveryDeps),
    async sendOne() {
      await fx.uploadValid(1);
      await fx.startAndRun();
      const receipt = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0] as Receipt;
      const attempt = (await fx.repository.attempts.listByReceipt(receipt.sha256)).at(-1) as Attempt;
      return { receipt, attempt };
    },
    async deliver(webhookRequestId, ...events) {
      await recordWebhook.execute({
        webhookRequestId,
        provider: 'ZEPTOMAIL',
        receivedAt: fx.clock.now(),
        body: '{}',
        events: events.map((e) => ({ eventId: `${webhookRequestId}:${(n += 1)}`, occurredAt: fx.clock.now(), source: 'WEBHOOK' as const, ...e })),
      });
      return processWebhook.execute(webhookRequestId);
    },
    async receipt(sha256) {
      return (await fx.repository.receipts.get(sha256 as never)) as Receipt;
    },
  };
}
