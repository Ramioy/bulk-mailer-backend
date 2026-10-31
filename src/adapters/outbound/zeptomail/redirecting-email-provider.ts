import type { EmailProvider, OutgoingEmail } from '../../../ports/email-provider';

/**
 * Outside production every email goes to a test mailbox, whatever the resolved recipient (§15).
 * The subject shows who it was meant for. The archive copy, if any, goes to the same test mailbox.
 */
export class RedirectingEmailProvider implements EmailProvider {
  constructor(
    private readonly inner: EmailProvider,
    private readonly testMailbox: string,
  ) {}

  send(email: OutgoingEmail) {
    return this.inner.send({
      ...email,
      to: this.testMailbox,
      ...(email.copyTo ? { copyTo: this.testMailbox } : {}),
      subject: `[PRUEBA → ${email.to}] ${email.subject}`,
    });
  }
}
