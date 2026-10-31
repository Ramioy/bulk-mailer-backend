import { describe, expect, it } from 'vitest';

import { ConceptCatalog, INITIAL_CONCEPTS, MAX_CONCEPT_KEY_LENGTH, validateConceptKey, validateConceptSubject } from './concept';

describe('ConceptCatalog', () => {
  const catalog = new ConceptCatalog([...INITIAL_CONCEPTS, { key: 'OLD', subject: 'Old', active: false }]);

  it('finds active concepts by exact key', () => {
    expect(catalog.findActive('CUOTA EXTRA')?.subject).toBe('Cuota extra');
    expect(catalog.findActive('cuota extra')).toBeUndefined();
  });

  it('does not return retired concepts', () => {
    expect(catalog.findActive('OLD')).toBeUndefined();
  });
});

describe('validateConceptKey (D23)', () => {
  it('accepts words separated by single spaces and normalises to NFC', () => {
    expect(validateConceptKey('CUOTA EXTRA')).toEqual({ ok: true, value: 'CUOTA EXTRA' });
    expect(validateConceptKey('ADMINISTRACIÓN')).toEqual({ ok: true, value: 'ADMINISTRACIÓN' });
  });

  it.each([
    ['', 'EMPTY'],
    [' MULTA', 'SPACING'],
    ['MULTA ', 'SPACING'],
    ['CUOTA  EXTRA', 'SPACING'],
    ['CUOTA EXTRA', 'SPACING'],
    ['CUOTA\tEXTRA', 'CONTROL_CHARACTER'],
    ['MULTA CNTRT', 'RESERVED_WORD'],
    ['XCNCPTX', 'RESERVED_WORD'],
  ])('rejects %j as %s', (key, problem) => {
    expect(validateConceptKey(key)).toEqual({ ok: false, error: problem });
  });

  it('accepts a key only if the shortest file name with it fits in 150 characters', () => {
    expect(MAX_CONCEPT_KEY_LENGTH).toBe(130);
    expect(validateConceptKey('Ñ'.repeat(130)).ok).toBe(true);
    expect(validateConceptKey('Ñ'.repeat(131))).toEqual({ ok: false, error: 'TOO_LONG' });
  });
});

describe('validateConceptSubject', () => {
  it('trims and rejects empty or multi-line subjects', () => {
    expect(validateConceptSubject('  Cuota extra ')).toBe('Cuota extra');
    expect(validateConceptSubject('   ')).toBeUndefined();
    expect(validateConceptSubject('Cuota\nextra')).toBeUndefined();
  });
});
