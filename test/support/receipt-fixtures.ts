import { FakeContractSource } from '../../src/adapters/outbound/fakes/fake-contract-source';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { InMemoryReceiptFileStore } from '../../src/adapters/outbound/in-memory/in-memory-receipt-file-store';
import { BasicPdfInspector } from '../../src/adapters/outbound/pdf/basic-pdf-inspector';
import type { ReceiptDependencies } from '../../src/application/receipts/receipt-dependencies';
import { SerialExecutor } from '../../src/application/shared/serial-executor';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { DeleteReceiptFile, fileKeyOf } from '../../src/application/files/delete-receipt-file';

/** A minimal valid PDF whose content (and hash) depends on `seed`. */
export function pdfBytes(seed: string): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.7\n1 0 obj << /Seed (${seed}) >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
}

export const fileName = (detail: string, concept: string, contract: string) => `${detail} CNCPT ${concept} CNTRT ${contract}.pdf`;

export interface ReceiptFixture {
  readonly deps: ReceiptDependencies;
  readonly repository: InMemoryBulkMailerRepository;
  readonly files: InMemoryReceiptFileStore;
  readonly tayrona: FakeContractSource;
  readonly sap: FakeContractSource;
  readonly clock: FixedClock;
  /** Runs the queued file deletions (D41, D50), as the file lane would. Returns how many ran. */
  runFileJobs(): Promise<number>;
}

let ids = 0;

export function receiptFixture(): ReceiptFixture {
  const repository = new InMemoryBulkMailerRepository();
  const tayrona = new FakeContractSource({
    '104522': { complexName: 'Edificio Altos', email: 'admin@altos.com' },
    '98765': { complexName: 'Conjunto Las Palmas', email: 'palmas@correo.co' },
    '55555': { complexName: 'Inactivo', email: 'x@y.co', active: false },
  });
  const sap = new FakeContractSource({ '7001': { complexName: 'Anglo Torre', email: 'anglo@sap.co' } });
  // Mid-October 2026 in Bogota: operable periods are 2026-10 and 2026-09.
  const clock = new FixedClock('2026-10-15T15:00:00Z');
  const files = new InMemoryReceiptFileStore(() => clock.now());
  const deps: ReceiptDependencies = {
    repository,
    fileStore: files,
    inspector: new BasicPdfInspector(),
    contractSources: { TAYRONA: tayrona, SAP: sap },
    clock,
    newId: () => `id-${(ids += 1)}`,
    serial: new SerialExecutor(),
    timeZone: 'America/Bogota',
    fileNameOptions: {},
  };
  const jobs = new InMemoryJobQueue(() => clock.now(), () => repository.jobTable());
  const deleteFile = new DeleteReceiptFile({ repository, fileStore: files, serial: deps.serial });
  const runFileJobs = async () => {
    let ran = 0;
    for (let job = await jobs.claimNext(clock.now(), ['DELETE_RECEIPT_FILE']); job; job = await jobs.claimNext(clock.now(), ['DELETE_RECEIPT_FILE'])) {
      await deleteFile.execute(fileKeyOf(job.payload));
      await jobs.complete(job.jobId);
      ran += 1;
    }
    return ran;
  };
  return { deps, repository, files, tayrona, sap, clock, runFileJobs };
}
