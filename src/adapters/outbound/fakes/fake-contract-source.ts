import type { ContractLookup } from '../../../domain/recipient/recipient';
import type { ContractSource } from '../../../ports/contract-source';

export interface FakeContract {
  readonly complexName: string;
  readonly email: string | null;
  readonly active?: boolean;
}

/** Simulated contracts API. Only for tests and non-production environments. */
export class FakeContractSource implements ContractSource {
  private readonly contracts: Map<string, FakeContract>;
  private unavailable = false;
  readonly queries: string[] = [];

  constructor(contracts: Readonly<Record<string, FakeContract>> = {}) {
    this.contracts = new Map(Object.entries(contracts));
  }

  async get(contract: string): Promise<ContractLookup> {
    this.queries.push(contract);
    if (this.unavailable) return { kind: 'UNAVAILABLE', detail: 'simulated outage' };
    const found = this.contracts.get(contract);
    if (!found) return { kind: 'NOT_FOUND' };
    return { kind: 'FOUND', contract, active: found.active ?? true, complexName: found.complexName, email: found.email };
  }

  setContract(contract: string, data: FakeContract): void {
    this.contracts.set(contract, data);
  }

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }
}
