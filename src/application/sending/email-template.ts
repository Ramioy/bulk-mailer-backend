import type { Concept } from '../../domain/concept/concept';
import type { Period } from '../../domain/period/period';

/** `<concept subject> – <Month> <Year>`, e.g. `Cuota extra – Octubre 2026`. Does not include the contract. */
export function emailSubject(concept: Pick<Concept, 'subject'>, period: Period): string {
  return `${concept.subject} – ${period.label()}`;
}

/**
 * Plain-text body (no HTML). Provisional wording, pending approval by the business area.
 */
export function emailBody(concept: Pick<Concept, 'subject'>, period: Period, complexName: string): string {
  return [
    `Señores ${complexName}:`,
    '',
    `Adjuntamos el soporte de pago de ${concept.subject.toLowerCase()} correspondiente a ${period.label()}.`,
    '',
    'Este es un mensaje automático; por favor no responda a este correo.',
  ].join('\n');
}
