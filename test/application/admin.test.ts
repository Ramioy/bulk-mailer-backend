import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { ArchiveCopy } from '../../src/application/admin/archive-copy';
import { ListConcepts, ManageConcepts } from '../../src/application/admin/manage-concepts';
import { SerialExecutor } from '../../src/application/shared/serial-executor';

function fixture(archiveCopyAddress?: string) {
  const repository = new InMemoryBulkMailerRepository();
  let n = 0;
  const deps = { repository, clock: new FixedClock(), newId: () => `id-${(n += 1)}`, serial: new SerialExecutor(), ...(archiveCopyAddress ? { archiveCopyAddress } : {}) };
  return {
    repository,
    concepts: new ManageConcepts(deps),
    list: new ListConcepts(deps),
    archiveCopy: new ArchiveCopy(deps),
    audit: async () => (await repository.audit.list()).map((a) => [a.action, a.subject, a.previousValue, a.newValue]),
    events: async () => (await repository.outbox.lockPending(100)).map((p) => [p.event.type, p.event.payload.change ?? p.event.payload.enabled]),
  };
}

describe('concept catalog administration (§4.3, D23-D25)', () => {
  it('adds an active concept, audited, with its domain event', async () => {
    const fx = fixture();
    expect(await fx.concepts.add('op', 'SANCIÓN', ' Sanción ')).toEqual({ ok: true, value: { key: 'SANCIÓN', subject: 'Sanción', active: true } });
    expect((await fx.list.execute()).map((c) => c.key)).toEqual(['CUOTA EXTRA', 'MULTA', 'PAGO ADMINISTRACIÓN', 'SANCIÓN']);
    expect(await fx.audit()).toEqual([['CONCEPT_CHANGED', 'SANCIÓN', undefined, '{"subject":"Sanción","active":true}']]);
    expect(await fx.events()).toEqual([['CONCEPT_CHANGED', 'ADDED']]);
  });

  it('rejects an invalid key, an empty subject and an existing key (also a retired one)', async () => {
    const fx = fixture();
    expect(await fx.concepts.add('op', 'CUOTA  EXTRA', 'x')).toEqual({ ok: false, error: { code: 'INVALID_CONCEPT_KEY', reason: 'SPACING' } });
    expect(await fx.concepts.add('op', 'NUEVO', ' ')).toEqual({ ok: false, error: { code: 'INVALID_CONCEPT_SUBJECT' } });
    await fx.concepts.update('op', 'MULTA', { active: false });
    expect(await fx.concepts.add('op', 'MULTA', 'Multa')).toEqual({ ok: false, error: { code: 'CONCEPT_ALREADY_EXISTS' } });
    expect((await fx.audit()).length).toBe(1);
  });

  it('retires, reactivates and changes the subject, auditing the previous value; a no-op is not audited', async () => {
    const fx = fixture();
    expect(await fx.concepts.update('op', 'MULTA', { active: false })).toEqual({ ok: true, value: { key: 'MULTA', subject: 'Multa', active: false } });
    expect(await fx.concepts.update('op', 'MULTA', { active: false })).toMatchObject({ ok: true });
    await fx.concepts.update('op', 'MULTA', { active: true, subject: 'Multa por ruido' });
    await fx.concepts.update('op', 'MULTA', { subject: 'Multa' });
    expect(await fx.audit()).toEqual([
      ['CONCEPT_CHANGED', 'MULTA', '{"subject":"Multa","active":true}', '{"subject":"Multa","active":false}'],
      ['CONCEPT_CHANGED', 'MULTA', '{"subject":"Multa","active":false}', '{"subject":"Multa por ruido","active":true}'],
      ['CONCEPT_CHANGED', 'MULTA', '{"subject":"Multa por ruido","active":true}', '{"subject":"Multa","active":true}'],
    ]);
    expect(await fx.events()).toEqual([['CONCEPT_CHANGED', 'RETIRED'], ['CONCEPT_CHANGED', 'REACTIVATED'], ['CONCEPT_CHANGED', 'SUBJECT_CHANGED']]);
  });

  it('answers CONCEPT_NOT_FOUND, NOTHING_TO_CHANGE and INVALID_CONCEPT_SUBJECT', async () => {
    const fx = fixture();
    expect(await fx.concepts.update('op', 'NO EXISTE', { active: false })).toEqual({ ok: false, error: { code: 'CONCEPT_NOT_FOUND' } });
    expect(await fx.concepts.update('op', 'MULTA', {})).toEqual({ ok: false, error: { code: 'NOTHING_TO_CHANGE' } });
    expect(await fx.concepts.update('op', 'MULTA', { subject: '' })).toEqual({ ok: false, error: { code: 'INVALID_CONCEPT_SUBJECT' } });
  });
});

describe('archive copy setting (§10.5, D26)', () => {
  it('cannot be enabled without a configured address; disabling is always allowed', async () => {
    const fx = fixture();
    expect(await fx.archiveCopy.get()).toEqual({ enabled: false, address: null });
    expect(await fx.archiveCopy.set('op', true)).toEqual({ ok: false, error: { code: 'ARCHIVE_COPY_NOT_CONFIGURED' } });
    expect(await fx.archiveCopy.set('op', false)).toEqual({ ok: true, value: { enabled: false, address: null } });
    expect(await fx.audit()).toEqual([]);
  });

  it('is audited with the previous value, only when it changes', async () => {
    const fx = fixture('archivo@empresa.co');
    expect(await fx.archiveCopy.set('op', true)).toEqual({ ok: true, value: { enabled: true, address: 'archivo@empresa.co' } });
    await fx.archiveCopy.set('op', true);
    await fx.archiveCopy.set('op', false);
    expect(await fx.audit()).toEqual([
      ['ARCHIVE_COPY_CHANGED', 'archive-copy', 'false', 'true'],
      ['ARCHIVE_COPY_CHANGED', 'archive-copy', 'true', 'false'],
    ]);
    expect(await fx.events()).toEqual([['ARCHIVE_COPY_CHANGED', true], ['ARCHIVE_COPY_CHANGED', false]]);
    expect(await fx.repository.settings.archiveCopyEnabled()).toBe(false);
  });
});
