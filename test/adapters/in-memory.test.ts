import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { InMemoryReceiptFileStore } from '../../src/adapters/outbound/in-memory/in-memory-receipt-file-store';
import { bulkMailerRepositoryContract } from '../contracts/bulk-mailer-repository.contract';
import { jobQueueContract, transactionalJobsContract } from '../contracts/job-queue.contract';
import { receiptFileStoreContract } from '../contracts/receipt-file-store.contract';

bulkMailerRepositoryContract('in-memory', async () => new InMemoryBulkMailerRepository());
receiptFileStoreContract('in-memory', async () => new InMemoryReceiptFileStore());
jobQueueContract('in-memory', async () => new InMemoryJobQueue());
transactionalJobsContract('in-memory', async () => {
  const repository = new InMemoryBulkMailerRepository();
  return { repository, queue: new InMemoryJobQueue(undefined, () => repository.jobTable()) };
});
