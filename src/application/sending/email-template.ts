import type { Concept } from '../../domain/concept/concept';
import type { Period } from '../../domain/period/period';

/** Placeholders a template may use, written `{{name}}`. */
export const TEMPLATE_PLACEHOLDERS = ['conceptSubject', 'periodLabel', 'complexName', 'fileName'] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/** Subject and plain-text body (no HTML). The subject must not include the contract. */
export interface EmailTemplate {
  readonly subject: string;
  readonly body: string;
}

/** Wording approved by the business area (2026-10-31). Replaceable by configuration (EMAIL_TEMPLATE_FILE). */
export const DEFAULT_EMAIL_TEMPLATE: EmailTemplate = {
  subject: '{{conceptSubject}} – {{periodLabel}}',
  body: [
    'Señores {{complexName}}:',
    '',
    'Adjuntamos el soporte de pago de {{conceptSubject}} correspondiente a {{periodLabel}}.',
    '',
    'Este es un mensaje automático; por favor no responda a este correo.',
  ].join('\n'),
};

const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Problems of a template: unknown placeholders, empty parts, a subject that mentions the contract. */
export function templateProblems(template: EmailTemplate): string[] {
  const problems: string[] = [];
  if (template.subject.trim() === '') problems.push('subject is empty');
  if (template.body.trim() === '') problems.push('body is empty');
  for (const text of [template.subject, template.body]) {
    for (const [, name] of text.matchAll(PLACEHOLDER)) {
      if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name ?? '')) {
        problems.push(`unknown placeholder {{${name}}}; allowed: ${TEMPLATE_PLACEHOLDERS.join(', ')}`);
      }
    }
  }
  if (/\{\{\s*fileName\s*\}\}/.test(template.subject)) problems.push('the subject must not include the file name (it carries the contract)');
  return problems;
}

export interface TemplateValues {
  readonly concept: Pick<Concept, 'subject'>;
  readonly period: Period;
  readonly complexName: string;
  readonly fileName: string;
}

export function renderEmail(template: EmailTemplate, values: TemplateValues): { subject: string; textBody: string } {
  const data: Record<TemplatePlaceholder, string> = {
    conceptSubject: values.concept.subject,
    periodLabel: values.period.label(),
    complexName: values.complexName,
    fileName: values.fileName,
  };
  const fill = (text: string) => text.replace(PLACEHOLDER, (_match, name: string) => data[name as TemplatePlaceholder] ?? '');
  return { subject: fill(template.subject), textBody: fill(template.body) };
}
