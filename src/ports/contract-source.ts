import type { ContractSourceId } from '../domain/block/block';
import type { ContractLookup } from '../domain/recipient/recipient';

/** `GET /contratos/{contract}` of Tayrona or SAP. Never throws: failures are `UNAVAILABLE`. */
export interface ContractSource {
  get(contract: string): Promise<ContractLookup>;
}

/** One source per id; the block decides which one is used. */
export type ContractSources = Readonly<Record<ContractSourceId, ContractSource>>;
