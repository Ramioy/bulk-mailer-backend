import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import type { AdminDependencies } from './admin-dependencies';

export interface ArchiveCopySetting {
  readonly enabled: boolean;
  /** Configured address (`ARCHIVE_COPY_ADDRESS`), or null when there is none. */
  readonly address: string | null;
}

/**
 * Archive copy (bcc) setting (§10.5, D26): disabled by default, audited with the previous value. Enabling it needs a
 * configured address; disabling is always allowed. A change during an execution applies to the next one, because the
 * value is fixed when an execution starts.
 */
export class ArchiveCopy {
  constructor(private readonly deps: AdminDependencies) {}

  async get(): Promise<ArchiveCopySetting> {
    return { enabled: await this.deps.repository.settings.archiveCopyEnabled(), address: this.deps.archiveCopyAddress ?? null };
  }

  set(operator: string, enabled: boolean): Promise<Result<ArchiveCopySetting, { readonly code: 'ARCHIVE_COPY_NOT_CONFIGURED' }>> {
    return this.deps.serial.run(async () => {
      const { repository, clock, newId, archiveCopyAddress } = this.deps;
      if (enabled && !archiveCopyAddress) return err({ code: 'ARCHIVE_COPY_NOT_CONFIGURED' });
      const previous = await repository.settings.archiveCopyEnabled();
      if (previous !== enabled) {
        const now = clock.now();
        await repository.transaction(async (tx) => {
          await tx.settings.setArchiveCopyEnabled(enabled);
          await tx.audit.append({
            auditId: newId(),
            actor: operator,
            action: 'ARCHIVE_COPY_CHANGED',
            at: now,
            subject: 'archive-copy',
            previousValue: String(previous),
            newValue: String(enabled),
          });
          await tx.outbox.add(domainEvent(newId, 'ARCHIVE_COPY_CHANGED', now, { enabled, previous, by: operator }));
        });
      }
      return ok({ enabled, address: archiveCopyAddress ?? null });
    });
  }
}
