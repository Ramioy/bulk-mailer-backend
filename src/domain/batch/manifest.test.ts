import { describe, expect, it } from 'vitest';

import { toSha256 } from '../receipt/sha256';
import { buildManifest, diffManifests, type ManifestCandidate } from './manifest';

const hash = (c: string) => toSha256(c.repeat(64));

function candidate(overrides: Partial<ManifestCandidate> & { sha256: ManifestCandidate['sha256'] }): ManifestCandidate {
  return { state: 'PENDING', fileName: 'A CNCPT MULTA CNTRT 1.pdf', conceptKey: 'MULTA', contract: '1', email: 'a@x.co', fileAvailable: true, ...overrides };
}

describe('buildManifest', () => {
  it('includes only PENDING or FAILED receipts with a recipient and a file, sorted by name', () => {
    const manifest = buildManifest(3, [
      candidate({ sha256: hash('a'), fileName: 'b.pdf' }),
      candidate({ sha256: hash('b'), fileName: 'a.pdf', state: 'FAILED' }),
      candidate({ sha256: hash('c'), state: 'SENT' }),
      candidate({ sha256: hash('d'), state: 'INVALID' }),
      candidate({ sha256: hash('e'), state: 'UNCERTAIN' }),
      candidate({ sha256: hash('f'), email: undefined }),
      candidate({ sha256: hash('1'), state: 'FAILED', fileAvailable: false }),
    ]);
    expect(manifest.version).toBe(4);
    expect(manifest.entries.map((e) => e.fileName)).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('diffManifests', () => {
  const base = buildManifest(0, [candidate({ sha256: hash('a'), fileName: 'a.pdf' }), candidate({ sha256: hash('b'), fileName: 'b.pdf' })]);

  it('reports nothing for the same content', () => {
    expect(diffManifests(base, { ...base, version: 2 })).toEqual([]);
  });

  it('reports ADDED and REMOVED; a modified file is both', () => {
    const current = buildManifest(1, [candidate({ sha256: hash('a'), fileName: 'a.pdf' }), candidate({ sha256: hash('c'), fileName: 'b.pdf' })]);
    expect(diffManifests(base, current).map((d) => [d.type, d.sha256])).toEqual([
      ['ADDED', hash('c')],
      ['REMOVED', hash('b')],
    ]);
  });

  it('reports RENAMED when the same hash changed name, concept or contract', () => {
    const current = buildManifest(1, [candidate({ sha256: hash('a'), fileName: 'a.pdf', contract: '2' }), candidate({ sha256: hash('b'), fileName: 'b.pdf' })]);
    expect(diffManifests(base, current)).toMatchObject([{ type: 'RENAMED', sha256: hash('a'), previous: { contract: '1' }, current: { contract: '2' } }]);
  });

  it('reports RECIPIENT_CHANGED when only the email changed', () => {
    const current = buildManifest(1, [candidate({ sha256: hash('a'), fileName: 'a.pdf', email: 'new@x.co' }), candidate({ sha256: hash('b'), fileName: 'b.pdf' })]);
    expect(diffManifests(base, current)).toMatchObject([{ type: 'RECIPIENT_CHANGED', previous: { email: 'a@x.co' }, current: { email: 'new@x.co' } }]);
  });
});
