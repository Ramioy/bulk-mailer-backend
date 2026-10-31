import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryInstanceLease } from '../../src/adapters/outbound/in-memory/in-memory-instance-lease';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { InMemoryReceiptFileStore } from '../../src/adapters/outbound/in-memory/in-memory-receipt-file-store';
import { bulkMailerRepositoryContract } from '../contracts/bulk-mailer-repository.contract';
import { instanceLeaseContract } from '../contracts/instance-lease.contract';
import { jobQueueContract, transactionalJobsContract } from '../contracts/job-queue.contract';
import { receiptFileStoreContract } from '../contracts/receipt-file-store.contract';

bulkMailerRepositoryContract('in-memory', async () => new InMemoryBulkMailerRepository());
receiptFileStoreContract('in-memory', async () => new InMemoryReceiptFileStore());
jobQueueContract('in-memory', async () => new InMemoryJobQueue());
transactionalJobsContract('in-memory', async () => {
  const repository = new InMemoryBulkMailerRepository();
  return { repository, queue: new InMemoryJobQueue(undefined, () => repository.jobTable()) };
});
instanceLeaseContract('in-memory', async () => {
  const clock = new FixedClock();
  const lease = new InMemoryInstanceLease(() => clock.now());
  return { lease, expire: async () => clock.advance(31_000) };
});
