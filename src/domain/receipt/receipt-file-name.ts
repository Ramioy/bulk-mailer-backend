import type { Concept, ConceptCatalog } from '../concept/concept';
import { FileErrorType } from '../shared/error-types';
import { err, ok, type Result } from '../shared/result';

/** ZeptoMail's limit for the attachment name. */
export const MAX_FILE_NAME_LENGTH = 150;

const NAME_PATTERN = /^(?<detail>\S(?:.*\S)?) CNCPT (?<concept>\S+(?: \S+)*) CNTRT (?<contract>\d+)\.pdf$/;

export interface ReceiptFileName {
  /** NFC-normalised file name. */
  readonly name: string;
  readonly detail: string;
  readonly concept: Concept;
  /** Contract number used to query the source, without leading zeros. */
  readonly contract: string;
}

export interface FileNameOptions {
  /** When true, leading zeros in the contract are accepted and stripped. Default false. */
  readonly allowLeadingZeros?: boolean;
}

type FileNameError = typeof FileErrorType.INVALID_NAME | typeof FileErrorType.UNKNOWN_CONCEPT | typeof FileErrorType.NAME_TOO_LONG;

/**
 * `<property and details> CNCPT <concept> CNTRT <contract>.pdf`
 * Rules applied in order: NFC, each abbreviation exactly once, pattern (case-sensitive), active concept, length.
 */
export function parseReceiptFileName(
  rawName: string,
  catalog: ConceptCatalog,
  options: FileNameOptions = {},
): Result<ReceiptFileName, FileNameError> {
  const name = rawName.normalize('NFC');

  if (occurrences(name, 'CNCPT') !== 1 || occurrences(name, 'CNTRT') !== 1) return err(FileErrorType.INVALID_NAME);

  const groups = NAME_PATTERN.exec(name)?.groups;
  if (!groups?.detail || !groups.concept || !groups.contract) return err(FileErrorType.INVALID_NAME);

  const contract = normaliseContract(groups.contract, options.allowLeadingZeros ?? false);
  if (contract === undefined) return err(FileErrorType.INVALID_NAME);

  const concept = catalog.findActive(groups.concept);
  if (!concept) return err(FileErrorType.UNKNOWN_CONCEPT);

  if ([...name].length > MAX_FILE_NAME_LENGTH) return err(FileErrorType.NAME_TOO_LONG);

  return ok({ name, detail: groups.detail, concept, contract });
}

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

function normaliseContract(digits: string, allowLeadingZeros: boolean): string | undefined {
  if (!digits.startsWith('0')) return digits;
  if (!allowLeadingZeros) return undefined;
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? undefined : stripped;
}
