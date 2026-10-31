import { describe, expect, it } from 'vitest';

import { normaliseEmail, resolveRecipient, type ContractLookup } from './recipient';

const found = (overrides: Partial<Extract<ContractLookup, { kind: 'FOUND' }>> = {}): ContractLookup => ({
  kind: 'FOUND',
  contract: '104522',
  active: true,
  complexName: 'Edificio Altos',
  email: 'admin@altos.com',
  ...overrides,
});
const notSuppressed = () => false;

describe('resolveRecipient', () => {
  it('resolves an active contract with a valid email', () => {
    expect(resolveRecipient(found({ email: '  Admin@Altos.com ' }), notSuppressed)).toEqual({
      ok: true,
      value: { email: 'admin@altos.com', complexName: 'Edificio Altos' },
    });
  });

  it.each([
    [{ kind: 'NOT_FOUND' } as const, 'CONTRACT_NOT_FOUND'],
    [{ kind: 'UNAVAILABLE', detail: 'timeout' } as const, 'SOURCE_UNAVAILABLE'],
    [found({ active: false }), 'CONTRACT_INACTIVE'],
    [found({ email: null }), 'CONTRACT_WITHOUT_EMAIL'],
    [found({ email: '' }), 'CONTRACT_WITHOUT_EMAIL'],
    [found({ email: 'admin@altos' }), 'CONTRACT_WITHOUT_EMAIL'],
    [found({ email: 'admin altos@altos.com' }), 'CONTRACT_WITHOUT_EMAIL'],
  ])('maps %o to %s', (lookup, error) => {
    expect(resolveRecipient(lookup, notSuppressed)).toEqual({ ok: false, error });
  });

  it('flags a suppressed address', () => {
    expect(resolveRecipient(found(), (email) => email === 'admin@altos.com')).toEqual({ ok: false, error: 'EMAIL_SUPPRESSED' });
  });
});

describe('normaliseEmail (D27)', () => {
  it('trims and lower-cases the whole address, local part included', () => {
    expect(normaliseEmail('  Conjunto.Altos+SM_113@Clientes.TEST ')).toBe('conjunto.altos+sm_113@clientes.test');
  });
});
