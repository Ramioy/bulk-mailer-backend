import { describe, expect, it } from 'vitest';

import { Period } from '../../domain/period/period';
import { DEFAULT_EMAIL_TEMPLATE, renderEmail, templateProblems } from './email-template';

const values = { concept: { subject: 'Cuota extra' }, period: Period.of(2026, 10), complexName: 'Edificio Altos', fileName: 'x.pdf' };

describe('email template', () => {
  it('renders the approved default', () => {
    expect(renderEmail(DEFAULT_EMAIL_TEMPLATE, values)).toEqual({
      subject: 'Cuota extra – Octubre 2026',
      textBody:
        'Señores Edificio Altos:\n\nAdjuntamos el soporte de pago de Cuota extra correspondiente a Octubre 2026.\n\n' +
        'Este es un mensaje automático; por favor no responda a este correo.',
    });
    expect(templateProblems(DEFAULT_EMAIL_TEMPLATE)).toEqual([]);
  });

  it('renders a configured template, tolerating spaces inside the braces', () => {
    const rendered = renderEmail({ subject: 'Soporte {{ conceptSubject }}', body: 'Hola {{complexName}}, va {{fileName}}' }, values);
    expect(rendered).toEqual({ subject: 'Soporte Cuota extra', textBody: 'Hola Edificio Altos, va x.pdf' });
  });

  it('reports unknown placeholders, empty parts and a subject carrying the file name', () => {
    expect(templateProblems({ subject: '{{contract}}', body: '' })).toEqual([
      'body is empty',
      'unknown placeholder {{contract}}; allowed: conceptSubject, periodLabel, complexName, fileName',
    ]);
    expect(templateProblems({ subject: '{{fileName}}', body: 'b' })).toEqual(['the subject must not include the file name (it carries the contract)']);
  });
});
