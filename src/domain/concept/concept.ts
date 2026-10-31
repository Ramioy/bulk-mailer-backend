import { err, ok, type Result } from '../shared/result';

export interface Concept {
  /** Exact text that follows `CNCPT` in the file name, e.g. `CUOTA EXTRA`. */
  readonly key: string;
  /** Text of the concept in the email subject, e.g. `Cuota extra`. */
  readonly subject: string;
  /** A retired concept is not accepted in later uploads; it does not affect what was already sent. */
  readonly active: boolean;
}

export class ConceptCatalog {
  private readonly byKey: ReadonlyMap<string, Concept>;

  constructor(concepts: readonly Concept[]) {
    this.byKey = new Map(concepts.map((c) => [c.key.normalize('NFC'), c]));
  }

  /** Active concept with exactly this key (case-sensitive, NFC), or `undefined`. */
  findActive(key: string): Concept | undefined {
    const concept = this.byKey.get(key.normalize('NFC'));
    return concept?.active ? concept : undefined;
  }
}

export const INITIAL_CONCEPTS: readonly Concept[] = [
  { key: 'PAGO ADMINISTRACIÓN', subject: 'Pago administración', active: true },
  { key: 'CUOTA EXTRA', subject: 'Cuota extra', active: true },
  { key: 'MULTA', subject: 'Multa', active: true },
];

/**
 * Shortest valid file name around a key: `X CNCPT <key> CNTRT 1.pdf`. A key longer than this budget could never
 * appear in a name that fits in MAX_FILE_NAME_LENGTH (150).
 */
export const MAX_CONCEPT_KEY_LENGTH = 150 - 'X CNCPT  CNTRT 1.pdf'.length;

/** The key must be what the file name pattern accepts after `CNCPT`: words separated by exactly one space. */
const KEY_PATTERN = /^\S+(?: \S+)*$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;

export type ConceptKeyProblem = 'EMPTY' | 'SPACING' | 'RESERVED_WORD' | 'TOO_LONG' | 'CONTROL_CHARACTER';

/** Rules of a new concept key (D23): NFC, single spaces and none at the edges, no `CNCPT`/`CNTRT`, fits in a file name. */
export function validateConceptKey(raw: string): Result<string, ConceptKeyProblem> {
  const key = raw.normalize('NFC');
  if (key === '') return err('EMPTY');
  if (CONTROL_CHARACTERS.test(key)) return err('CONTROL_CHARACTER');
  // `\S` also excludes tabs and non-breaking spaces: only the plain space separates words.
  if (!KEY_PATTERN.test(key)) return err('SPACING');
  if (key.includes('CNCPT') || key.includes('CNTRT')) return err('RESERVED_WORD');
  if ([...key].length > MAX_CONCEPT_KEY_LENGTH) return err('TOO_LONG');
  return ok(key);
}

/** The subject is trimmed and NFC-normalised; it cannot be empty or carry control characters (line breaks). */
export function validateConceptSubject(raw: string): string | undefined {
  const subject = raw.normalize('NFC').trim();
  return subject === '' || CONTROL_CHARACTERS.test(subject) ? undefined : subject;
}
