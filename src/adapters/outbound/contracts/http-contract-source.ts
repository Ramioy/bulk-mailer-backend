import type { ContractLookup } from '../../../domain/recipient/recipient';
import type { ContractSource } from '../../../ports/contract-source';

export interface HttpContractSourceOptions {
  /** e.g. https://tayrona.internal/api */
  readonly baseUrl: string;
  /** Service token, sent as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Maximum wait; default 5 s (§6.1). */
  readonly timeoutMs: number;
  /** Injected for tests. */
  readonly fetch?: typeof fetch;
}

interface ContractBody {
  readonly contrato: unknown;
  readonly activo: unknown;
  readonly nombre_conjunto: unknown;
  readonly correo: unknown;
}

/**
 * Contracts API of Tayrona or SAP (both expose the same interface, §6.1). Never throws:
 * 404 → NOT_FOUND; timeout, network error, 5xx and anything unexpected → UNAVAILABLE.
 */
export class HttpContractSource implements ContractSource {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: HttpContractSourceOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async get(contract: string): Promise<ContractLookup> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/contratos/${encodeURIComponent(contract)}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      return { kind: 'UNAVAILABLE', detail: name === 'TimeoutError' ? `timeout after ${this.options.timeoutMs} ms` : `network: ${describe(error)}` };
    }

    if (response.status === 404) return { kind: 'NOT_FOUND' };
    if (response.status !== 200) return { kind: 'UNAVAILABLE', detail: `HTTP ${response.status}` };

    let body: ContractBody;
    try {
      body = (await response.json()) as ContractBody;
    } catch {
      return { kind: 'UNAVAILABLE', detail: 'malformed JSON body' };
    }
    if (typeof body !== 'object' || body === null || typeof body.activo !== 'boolean' || typeof body.nombre_conjunto !== 'string') {
      return { kind: 'UNAVAILABLE', detail: 'unexpected body' };
    }
    if (String(body.contrato) !== contract) return { kind: 'UNAVAILABLE', detail: `answered for contract ${String(body.contrato)}` };

    // An empty or invalid email is a business answer (CONTRACT_WITHOUT_EMAIL), not a failure of the source.
    const email = typeof body.correo === 'string' ? body.correo : null;
    return { kind: 'FOUND', contract, active: body.activo, complexName: body.nombre_conjunto, email };
  }
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? String(error);
}
