import type { SendOutcome } from '../../../domain/sending/send-outcome';
import type { EmailProvider, OutgoingEmail } from '../../../ports/email-provider';

/**
 * Simulated provider. Answers with the scripted outcomes in order, then accepts everything.
 * Every call is recorded, including the ones that "failed", to assert what left the system.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly calls: OutgoingEmail[] = [];
  private readonly script: Array<SendOutcome | ((email: OutgoingEmail) => SendOutcome)> = [];

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    this.calls.push(email);
    const next = this.script.shift();
    if (next === undefined) return { kind: 'ACCEPTED', providerRequestId: `fake-${email.attemptId}` };
    return typeof next === 'function' ? next(email) : next;
  }

  /** Queues outcomes for the next calls. */
  respondWith(...outcomes: Array<SendOutcome | ((email: OutgoingEmail) => SendOutcome)>): this {
    this.script.push(...outcomes);
    return this;
  }
}
