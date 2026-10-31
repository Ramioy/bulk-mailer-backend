import { describe, expect, it } from 'vitest';

import { ConceptCatalog, INITIAL_CONCEPTS } from './concept';

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
