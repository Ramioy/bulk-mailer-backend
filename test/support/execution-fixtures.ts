import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { RecordingAlertNotifier, RecordingProgressNotifier } from '../../src/adapters/outbound/fakes/recording-notifiers';
import { InProcessEventBus } from '../../src/adapters/outbound/events/in-process-event-bus';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { alertFromEvent } from '../../src/application/alerts/raise-alert';
import { OutboxRelay } from '../../src/application/events/outbox-relay';
import { UploadReceipts } from '../../src/application/receipts/upload-receipts';
import type { ExecutionDependencies } from '../../src/application/sending/execution-dependencies';
import { fileKeyOf } from '../../src/application/files/delete-receipt-file';
import { AbortExecution } from '../../src/application/sending/abort-execution';
import { fileUseCases, type FileUseCases } from '../../src/composition/file-use-cases';
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
  readonly abort: AbortExecution;
  /** D41: the file lane's use cases (delete, batch purge, orphan sweep). */
  readonly fileJobs: FileUseCases;
  /** Runs the queued file jobs, as the file lane would (D41). Returns how many ran. */
  runFileJobs(): Promise<number>;
  /** Uploads `count` valid receipts to 2026-10/CASH and returns the manifest version. */
  uploadValid(count: number): Promise<number>;
  /** Starts the execution of the current manifest and runs it to the end, then the file jobs it queued (D41). */
  startAndRun(): Promise<string>;
}

export function executionFixture(overrides: Partial<ExecutionDependencies> = {}): ExecutionFixture {
  const base = receiptFixture();
  const email = new FakeEmailProvider();
  // Same jobs table as the repository (D40): jobs queued inside a transaction are claimed here.
  const jobs = new InMemoryJobQueue(() => base.clock.now(), () => base.repository.jobTable());
  const progress = new RecordingProgressNotifier();
  const alerts = new RecordingAlertNotifier();
  const execDeps: ExecutionDependencies = {
    repository: base.repository,
    fileStore: base.files,
    contractSources: base.deps.contractSources,
    emailProvider: email,
    progress,
    clock: base.clock,
    newId: base.deps.newId,
    serial: base.deps.serial,
    timeZone: base.deps.timeZone,
    pauseBetweenSendsMs: 1000,
    incidentPolicy: DEFAULT_PROVIDER_INCIDENT_POLICY,
    emailTemplate: DEFAULT_EMAIL_TEMPLATE,
    abortAfterMinutes: 10,
    ...overrides,
  };
  const bus = new InProcessEventBus();
  bus.subscribe('ALERT_RAISED', (event) => alerts.notify(alertFromEvent(event.payload)));
  const relay = new OutboxRelay(base.repository, bus, base.clock);
  const upload = new UploadReceipts(base.deps);
  const start = new StartExecution(execDeps);
  const run = new RunExecution(execDeps);
  const fileJobs = fileUseCases({
    repository: base.repository,
    fileStore: base.files,
    jobQueue: jobs,
    clock: base.clock,
    newId: base.deps.newId,
    serial: base.deps.serial,
    orphanMinAgeMinutes: 60,
  });
  const runFileJobs = async () => {
    let ran = 0;
    for (let job = await jobs.claimNext(base.clock.now(), ['DELETE_RECEIPT_FILE', 'PURGE_BATCH_FILES']); job; job = await jobs.claimNext(base.clock.now(), ['DELETE_RECEIPT_FILE', 'PURGE_BATCH_FILES'])) {
      if (job.type === 'DELETE_RECEIPT_FILE') await fileJobs.deleteFile.execute(fileKeyOf(job.payload));
      else await fileJobs.purgeBatch.execute(job.payload);
      await jobs.complete(job.jobId);
      ran += 1;
    }
    return ran;
  };

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
    abort: new AbortExecution(execDeps),
    fileJobs,
    runFileJobs,
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
      await runFileJobs();
      return started.value.executionId;
    },
  };
}
