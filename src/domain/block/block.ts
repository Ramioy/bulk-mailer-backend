export const ContractSourceId = {
  TAYRONA: 'TAYRONA',
  SAP: 'SAP',
} as const;
export type ContractSourceId = (typeof ContractSourceId)[keyof typeof ContractSourceId];

export const Block = {
  CASH: 'CASH',
  AVVILLAS: 'AVVILLAS',
  BANCOLOMBIA: 'BANCOLOMBIA',
  DAVIVIENDA: 'DAVIVIENDA',
  ANGLO: 'ANGLO',
  OTHERS: 'OTHERS',
} as const;
export type Block = (typeof Block)[keyof typeof Block];

/** Contract source that resolves the recipients of each block. */
const CONTRACT_SOURCE_BY_BLOCK: Readonly<Record<Block, ContractSourceId>> = {
  CASH: 'TAYRONA',
  AVVILLAS: 'TAYRONA',
  BANCOLOMBIA: 'TAYRONA',
  DAVIVIENDA: 'TAYRONA',
  ANGLO: 'SAP',
  OTHERS: 'TAYRONA',
};

export const BLOCKS: readonly Block[] = Object.values(Block);

export function isBlock(value: string): value is Block {
  return (BLOCKS as readonly string[]).includes(value);
}

export function contractSourceOf(block: Block): ContractSourceId {
  return CONTRACT_SOURCE_BY_BLOCK[block];
}
