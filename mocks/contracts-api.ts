/**
 * Simulated contracts API (Tayrona / SAP), following the contract of docs/context/06-receipt-recipient-matching.md §6.1:
 *
 *   GET /contratos/{contrato}   Authorization: Bearer <service token>
 *   200 → { "contrato": "104522", "activo": true, "nombre_conjunto": "Edificio Altos", "correo": "admin@altos.com" }
 *   404 → the contract does not exist
 *
 * Special contracts simulate failures:
 *   9990500 → 500        9990503 → 503        9990504 → never answers in time (10 s)
 *   9990200 → 200 with a malformed body
 *
 * Run: node mocks/contracts-api.ts  (PORT, MOCK_TOKEN, MOCK_CONTRACTS_FILE with { "<contrato>": { activo, nombre_conjunto, correo } })
 */
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import Fastify, { type FastifyInstance } from 'fastify';

export interface MockContract {
  readonly activo: boolean;
  readonly nombre_conjunto: string;
  readonly correo: string | null;
}

export interface ContractsApiMockOptions {
  readonly token: string;
  readonly contracts: Readonly<Record<string, MockContract>>;
  /** Slow-contract delay; default 10 s. */
  readonly slowMs?: number;
}

export function createContractsApiMock(options: ContractsApiMockOptions): FastifyInstance & { readonly requests: string[] } {
  const app = Fastify({ logger: false });
  const requests: string[] = [];

  app.get<{ Params: { contrato: string } }>('/contratos/:contrato', async (request, reply) => {
    const { contrato } = request.params;
    requests.push(contrato);
    if (request.headers.authorization !== `Bearer ${options.token}`) return reply.code(401).send({ error: 'unauthorized' });

    switch (contrato) {
      case '9990500':
        return reply.code(500).send({ error: 'internal' });
      case '9990503':
        return reply.code(503).send({ error: 'unavailable' });
      case '9990504':
        await delay(options.slowMs ?? 10_000);
        return reply.code(200).send({ contrato, activo: true, nombre_conjunto: 'Lento', correo: 'lento@example.com' });
      case '9990200':
        return reply.code(200).type('application/json').send('{"contrato": ');
    }
    const found = options.contracts[contrato];
    if (!found) return reply.code(404).send({ error: 'not found' });
    return { contrato, ...found };
  });

  return Object.assign(app, { requests });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.env.MOCK_CONTRACTS_FILE;
  const contracts = file ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, MockContract>) : {};
  const app = createContractsApiMock({ token: process.env.MOCK_TOKEN ?? 'dev-token', contracts });
  const port = Number(process.env.PORT ?? '4001');
  await app.listen({ port, host: '127.0.0.1' });
  process.stdout.write(`Contracts API mock on http://127.0.0.1:${port} (${Object.keys(contracts).length} contracts)\n`);
}
