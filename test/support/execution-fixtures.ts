import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { RecordingAlertNotifier, RecordingProgressNotifier } from '../../src/adapters/outbound/fakes/recording-notifiers';
import { InProcessEventBus } from '../../src/adapters/outbound/events/in-process-event-bus';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { alertFromEvent } from '../../src/application/alerts/raise-alert';
import { OutboxRelay } from '../../src/application/events/outbox-relay';
import { UploadReceipts } from '../../src/application/receipts/upload-receipts';
import type { ExecutionDependencies } from '../../src/application/sending/execution-dependencies';
import { GetExecution } from '../../src/application/sending/get-execution';
import { RecoverAfterCrash } from '../../src/application/sending/recover-after-crash';
import { RunExecution } from '../../src/application/sending/run-execution';
import { StartExecution } from '../../src/application/sending/start-execution';
import { DEFAULT_EMAIL_TEMPLATE } from '../../src/application/sending/email-template';
import { DEFAULT_PROVIDER_INCIDENT_POLICY } from '../../src/domain/sending/incident-policy';
import { OCT_2026 } from './builders';
import { fileName, pdfBytes, receiptFixture, type ReceiptFixture } from './receipt-fixtures';

export interface ExecutionFixture extends ReceiptFixture {
  readonly email: FakeEmailProvider;
  readonly jobs: InMemoryJobQueue;
  readonly progress: RecordingProgressNotifier;
  readonly alerts: RecordingAlertNotifier;
  readonly bus: InProcessEventBus;
  /** Delivers the outbox (alerts reach `alerts` only through it). */
  readonly relay: OutboxRelay;
  readonly execDeps: ExecutionDependencies;
  readonly upload: UploadReceipts;
  readonly start: StartExecution;
  readonly run: RunExecution;
  readonly recover: RecoverAfterCrash;
  readonly status: GetExecution;
  /** Uploads `count` valid receipts to 2026-10/CASH and returns the manifest version. */
  uploadValid(count: number): Promise<number>;
  /** Starts the execution of the current manifest and runs it to the end. */
  startAndRun(): Promise<string>;
}

export function executionFixture(overrides: Partial<ExecutionDependencies> = {}): ExecutionFixture {
  const base = receiptFixture();
  const email = new FakeEmailProvider();
  const jobs = new InMemoryJobQueue(() => base.clock.now());
  const progress = new RecordingProgressNotifier();
  const alerts = new RecordingAlertNotifier();
  const execDeps: ExecutionDependencies = {
    repository: base.repository,
    fileStore: base.files,
    contractSources: base.deps.contractSources,
    emailProvider: email,
    jobQueue: jobs,
    progress,
    clock: base.clock,
    newId: base.deps.newId,
    serial: base.deps.serial,
    timeZone: base.deps.timeZone,
    pauseBetweenSendsMs: 1000,
    incidentPolicy: DEFAULT_PROVIDER_INCIDENT_POLICY,
    emailTemplate: DEFAULT_EMAIL_TEMPLATE,
    ...overrides,
  };
  const bus = new InProcessEventBus();
  bus.subscribe('ALERT_RAISED', (event) => alerts.notify(alertFromEvent(event.payload)));
  const relay = new OutboxRelay(base.repository, bus, base.clock);
  const upload = new UploadReceipts(base.deps);
  const start = new StartExecution(execDeps);
  const run = new RunExecution(execDeps);

  return {
    ...base,
    email,
    jobs,
    progress,
    alerts,
    bus,
    relay,
    execDeps,
    upload,
    start,
    run,
    recover: new RecoverAfterCrash(execDeps),
    status: new GetExecution(execDeps),
    async uploadValid(count) {
      const files = Array.from({ length: count }, (_, i) => ({
        name: fileName(`Edificio Altos ${String(i).padStart(2, '0')}`, 'MULTA', '104522'),
        content: pdfBytes(`receipt-${i}`),
      }));
      const result = await upload.execute('operador', OCT_2026, 'CASH', files);
      if (!result.ok) throw new Error(result.error);
      return result.value.manifestVersion;
    },
    async startAndRun() {
      const batch = await base.repository.batches.get(OCT_2026, 'CASH');
      const started = await start.execute('operador', OCT_2026, 'CASH', batch?.manifestVersion ?? 0);
      if (!started.ok) throw new Error(started.error.code);
      const job = await jobs.claimNext(base.clock.now(), ['EXECUTE_BATCH']);
      if (job?.type !== 'EXECUTE_BATCH') throw new Error('no execution job');
      await run.execute(job.payload.executionId as string);
      await jobs.complete(job.jobId);
      return started.value.executionId;
    },
  };
}
