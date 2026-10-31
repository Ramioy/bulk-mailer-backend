import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

import { LocalVolumeFileStore } from '../../src/adapters/outbound/volume/local-volume-file-store';
import { receiptFileStoreContract } from '../contracts/receipt-file-store.contract';

const roots: string[] = [];

receiptFileStoreContract('local volume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bulk-mailer-volume-'));
  roots.push(root);
  return new LocalVolumeFileStore(root);
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
