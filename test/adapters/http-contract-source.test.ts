import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpContractSource } from '../../src/adapters/outbound/contracts/http-contract-source';
import { createContractsApiMock } from '../../mocks/contracts-api';

describe('HttpContractSource against the simulated contracts API', () => {
  const mock = createContractsApiMock({
    token: 'svc-token',
    slowMs: 2_000,
    contracts: {
      '104522': { activo: true, nombre_conjunto: 'Edificio Altos', correo: 'admin@altos.com' },
      '55555': { activo: false, nombre_conjunto: 'Inactivo', correo: 'x@y.co' },
      '44444': { activo: true, nombre_conjunto: 'Sin correo', correo: null },
      '33333': { activo: true, nombre_conjunto: 'Correo malo', correo: 'no-es-correo' },
    },
  });
  let source: HttpContractSource;
  let baseUrl: string;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}/`;
    source = new HttpContractSource({ baseUrl, token: 'svc-token', timeoutMs: 500 });
  });

  afterAll(async () => {
    await mock.close();
  });

  it('maps a found contract', async () => {
    expect(await source.get('104522')).toEqual({ kind: 'FOUND', contract: '104522', active: true, complexName: 'Edificio Altos', email: 'admin@altos.com' });
  });

  it('passes inactive contracts and missing or invalid emails to the domain, which classifies them', async () => {
    expect(await source.get('55555')).toMatchObject({ kind: 'FOUND', active: false });
    expect(await source.get('44444')).toMatchObject({ kind: 'FOUND', email: null });
    expect(await source.get('33333')).toMatchObject({ kind: 'FOUND', email: 'no-es-correo' });
  });

  it('maps 404 to NOT_FOUND', async () => {
    expect(await source.get('1')).toEqual({ kind: 'NOT_FOUND' });
  });

  it.each([
    ['9990500', 'HTTP 500'],
    ['9990503', 'HTTP 503'],
    ['9990200', 'malformed JSON body'],
    ['9990504', 'timeout after 500 ms'],
  ])('maps contract %s to UNAVAILABLE (%s)', async (contract, detail) => {
    expect(await source.get(contract)).toEqual({ kind: 'UNAVAILABLE', detail });
  });

  it('sends the service token; a wrong token is UNAVAILABLE, not NOT_FOUND', async () => {
    const wrong = new HttpContractSource({ baseUrl, token: 'other', timeoutMs: 500 });
    expect(await wrong.get('104522')).toEqual({ kind: 'UNAVAILABLE', detail: 'HTTP 401' });
  });

  it('maps a refused connection to UNAVAILABLE', async () => {
    const down = new HttpContractSource({ baseUrl: 'http://127.0.0.1:1', token: 't', timeoutMs: 500 });
    expect(await down.get('104522')).toMatchObject({ kind: 'UNAVAILABLE', detail: expect.stringContaining('network') });
  });

  it('encodes the contract in the path', async () => {
    await source.get('12/34');
    expect(mock.requests.at(-1)).toBe('12/34');
  });
});
