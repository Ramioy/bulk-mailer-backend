import { describe, expect, it } from 'vitest';

import { ConceptCatalog, INITIAL_CONCEPTS } from '../concept/concept';
import { parseReceiptFileName } from './receipt-file-name';

const catalog = new ConceptCatalog([...INITIAL_CONCEPTS, { key: 'RETIRADO', subject: 'Retirado', active: false }]);

describe('parseReceiptFileName', () => {
  // Examples table of docs/context/04-file-name.md §4.2
  it.each([
    ['Edificio Altos Torre 2 oct CNCPT CUOTA EXTRA CNTRT 104522.pdf', 'CUOTA EXTRA', '104522'],
    ['Conjunto Las Palmas CNCPT PAGO ADMINISTRACIÓN CNTRT 98765.pdf', 'PAGO ADMINISTRACIÓN', '98765'],
  ])('accepts %s', (name, concept, contract) => {
    const result = parseReceiptFileName(name, catalog);
    expect(result).toMatchObject({ ok: true, value: { concept: { key: concept }, contract } });
  });

  it.each([
    ['Conjunto Las Palmas CNCPT PAGO ADMINISTRACIÓN CNTRT 98 765.pdf', 'INVALID_NAME', 'space in the contract'],
    ['Conjunto Las Palmas CNTRT 98765 CNCPT MULTA.pdf', 'INVALID_NAME', 'reversed order'],
    ['Conjunto Las Palmas CNCPT  MULTA CNTRT 98765.pdf', 'INVALID_NAME', 'double space after CNCPT'],
    ['Conjunto Las Palmas CNCPT CUOTA  EXTRA CNTRT 98765.pdf', 'INVALID_NAME', 'double space inside the concept'],
    ['Conjunto Las Palmas cncpt MULTA cntrt 98765.pdf', 'INVALID_NAME', 'lower-case abbreviations'],
    ['Conjunto Las Palmas CNCPT MULTA CNTRT 98765.PDF', 'INVALID_NAME', 'upper-case extension'],
    ['Conjunto Las Palmas CNCPT Multa CNTRT 98765.pdf', 'UNKNOWN_CONCEPT', 'concept not in the catalog'],
    ['Conjunto Las Palmas CNCPT MULTA CNTRT 098765.pdf', 'INVALID_NAME', 'leading zero'],
    ['Conjunto Las Palmas CNCPT MULTA CNTRT 111 CNTRT 222.pdf', 'INVALID_NAME', 'CNTRT repeated'],
    ['Conjunto Las Palmas MULTA 98765.pdf', 'INVALID_NAME', 'abbreviations missing'],
    ['Conjunto Las Palmas CNCPT RETIRADO CNTRT 98765.pdf', 'UNKNOWN_CONCEPT', 'retired concept'],
    [' Conjunto CNCPT MULTA CNTRT 98765.pdf', 'INVALID_NAME', 'leading space in the detail'],
    [`${'x'.repeat(130)} CNCPT MULTA CNTRT 98765.pdf`, 'NAME_TOO_LONG', 'more than 150 characters'],
  ])('rejects %s (%s: %s)', (name, error) => {
    expect(parseReceiptFileName(name, catalog)).toEqual({ ok: false, error });
  });

  it('treats a decomposed accent like a composed one (NFC)', () => {
    const decomposed = 'Conjunto CNCPT PAGO ADMINISTRACIÓN CNTRT 1.pdf';
    const result = parseReceiptFileName(decomposed, catalog);
    expect(result).toMatchObject({ ok: true, value: { name: decomposed.normalize('NFC'), concept: { key: 'PAGO ADMINISTRACIÓN' } } });
  });

  it('accepts exactly 150 characters', () => {
    const name = `${'x'.repeat(122)} CNCPT MULTA CNTRT 98765.pdf`;
    expect(name).toHaveLength(150);
    expect(parseReceiptFileName(name, catalog).ok).toBe(true);
  });

  it('strips leading zeros when configured', () => {
    const result = parseReceiptFileName('Conjunto CNCPT MULTA CNTRT 00098765.pdf', catalog, { allowLeadingZeros: true });
    expect(result).toMatchObject({ ok: true, value: { contract: '98765' } });
  });

  it('rejects an all-zero contract even when leading zeros are allowed', () => {
    expect(parseReceiptFileName('Conjunto CNCPT MULTA CNTRT 000.pdf', catalog, { allowLeadingZeros: true })).toEqual({
      ok: false,
      error: 'INVALID_NAME',
    });
  });
});
