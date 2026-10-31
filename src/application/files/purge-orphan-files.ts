import { raiseAlert } from '../alerts/raise-alert';
import type { FileDependencies } from './file-dependencies';

export interface OrphanSweepResult {
  /** Files deleted because no receipt needs them. */
  readonly deleted: number;
  /** Files too recent to judge (an upload may be writing its row). */
  readonly tooRecent: number;
  readonly failed: number;
}

/**
 * D41: periodic sweep of the volume. Deletes every file whose receipt does not exist, does not need it
 * (`fileAvailable` false) or lives elsewhere now: what a crash between a commit and its deletion job, or a failed
 * deletion, left behind. Files younger than `orphanMinAgeMinutes` are left alone: an upload writes the file just before
 * its row. Each deletion re-checks the receipt inside the serial executor. Alerts only if deletions fail.
 */
export class PurgeOrphanFiles {
  constructor(private readonly deps: FileDependencies) {}

  /** Queues the sweep unless one is already waiting or running (as D38). */
  async request(): Promise<boolean> {
    if (await this.deps.jobQueue.hasPending('PURGE_ORPHAN_FILES')) return false;
    await this.deps.jobQueue.enqueue({ type: 'PURGE_ORPHAN_FILES', payload: {} });
    return true;
  }

  async execute(): Promise<OrphanSweepResult> {
    const { repository, fileStore, clock, newId, serial, orphanMinAgeMinutes } = this.deps;
    const oldest = clock.now().getTime() - orphanMinAgeMinutes * 60_000;
    let deleted = 0;
    let tooRecent = 0;
    const failures: string[] = [];
    for (const file of await fileStore.list()) {
      if (file.modifiedAt.getTime() > oldest) {
        tooRecent += 1;
        continue;
      }
      try {
        const removed = await serial.run(async () => {
          const receipt = await repository.receipts.get(file.sha256);
          if (receipt?.fileAvailable && receipt.period.equals(file.period) && receipt.block === file.block) return false;
          await fileStore.delete(file);
          return true;
        });
        if (removed) deleted += 1;
      } catch (error) {
        failures.push(`${file.period.toString()}/${file.block}/${file.sha256}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      await repository.transaction((tx) =>
        raiseAlert(tx, newId, {
          alertId: newId(),
          type: 'FILE_PURGE_FAILED',
          subject: 'receipt-files',
          detail: `${failures.length} file(s) that no receipt needs could not be deleted: ${failures.slice(0, 5).join('; ')}`,
          raisedAt: clock.now(),
        }),
      );
    }
    return { deleted, tooRecent, failed: failures.length };
  }
}
