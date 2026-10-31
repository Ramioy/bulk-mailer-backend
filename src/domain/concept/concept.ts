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
