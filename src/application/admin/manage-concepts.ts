import { type Concept, type ConceptKeyProblem, validateConceptKey, validateConceptSubject } from '../../domain/concept/concept';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import type { AdminDependencies } from './admin-dependencies';

export type ConceptError =
  | { readonly code: 'INVALID_CONCEPT_KEY'; readonly reason: ConceptKeyProblem }
  | { readonly code: 'INVALID_CONCEPT_SUBJECT' | 'CONCEPT_ALREADY_EXISTS' | 'CONCEPT_NOT_FOUND' | 'NOTHING_TO_CHANGE' };

export interface ConceptChange {
  readonly subject?: string;
  readonly active?: boolean;
}

/** Every concept, active and retired, ordered by key (§4.3). */
export class ListConcepts {
  constructor(private readonly deps: Pick<AdminDependencies, 'repository'>) {}

  async execute(): Promise<Concept[]> {
    return (await this.deps.repository.concepts.list()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

/**
 * Catalog administration (§4.3, D23). A concept is added with a new key; afterwards only its subject and whether it
 * is active can change (the key identifies it in the file names). Changes apply to later uploads and sends; what was
 * already sent is not touched, and receipts already loaded stay as they are (D25). Every change is audited.
 */
export class ManageConcepts {
  constructor(private readonly deps: AdminDependencies) {}

  add(operator: string, rawKey: string, rawSubject: string): Promise<Result<Concept, ConceptError>> {
    return this.deps.serial.run(async () => {
      const key = validateConceptKey(rawKey);
      if (!key.ok) return err({ code: 'INVALID_CONCEPT_KEY', reason: key.error });
      const subject = validateConceptSubject(rawSubject);
      if (subject === undefined) return err({ code: 'INVALID_CONCEPT_SUBJECT' });
      if (await this.find(key.value)) return err({ code: 'CONCEPT_ALREADY_EXISTS' });

      const concept: Concept = { key: key.value, subject, active: true };
      await this.record(operator, undefined, concept);
      return ok(concept);
    });
  }

  /** Changes the subject and/or reactivates or retires. A request that changes nothing is not audited. */
  update(operator: string, rawKey: string, change: ConceptChange): Promise<Result<Concept, ConceptError>> {
    return this.deps.serial.run(async () => {
      if (change.subject === undefined && change.active === undefined) return err({ code: 'NOTHING_TO_CHANGE' });
      const subject = change.subject === undefined ? undefined : validateConceptSubject(change.subject);
      if (change.subject !== undefined && subject === undefined) return err({ code: 'INVALID_CONCEPT_SUBJECT' });
      const current = await this.find(rawKey.normalize('NFC'));
      if (!current) return err({ code: 'CONCEPT_NOT_FOUND' });

      const next: Concept = { key: current.key, subject: subject ?? current.subject, active: change.active ?? current.active };
      if (next.subject === current.subject && next.active === current.active) return ok(current);
      await this.record(operator, current, next);
      return ok(next);
    });
  }

  private async find(key: string): Promise<Concept | undefined> {
    return (await this.deps.repository.concepts.list()).find((c) => c.key.normalize('NFC') === key);
  }

  private async record(operator: string, previous: Concept | undefined, next: Concept): Promise<void> {
    const { repository, clock, newId } = this.deps;
    const now = clock.now();
    const describe = (c: Concept) => JSON.stringify({ subject: c.subject, active: c.active });
    await repository.transaction(async (tx) => {
      await tx.concepts.save(next);
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'CONCEPT_CHANGED',
        at: now,
        subject: next.key,
        ...(previous ? { previousValue: describe(previous) } : {}),
        newValue: describe(next),
      });
      await tx.outbox.add(
        domainEvent(newId, 'CONCEPT_CHANGED', now, {
          key: next.key,
          change: changeKind(previous, next),
          subject: next.subject,
          active: next.active,
          ...(previous ? { previousSubject: previous.subject, previousActive: previous.active } : {}),
          by: operator,
        }),
      );
    });
  }
}

function changeKind(previous: Concept | undefined, next: Concept): string {
  if (!previous) return 'ADDED';
  if (previous.active !== next.active) return next.active ? 'REACTIVATED' : 'RETIRED';
  return 'SUBJECT_CHANGED';
}
