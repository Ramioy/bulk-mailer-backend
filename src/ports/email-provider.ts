import type { SendOutcome } from '../domain/sending/send-outcome';

export interface OutgoingEmail {
  /** Travels as the provider's client reference. */
  readonly attemptId: string;
  readonly to: string;
  readonly copyTo?: string;
  readonly subject: string;
  readonly textBody: string;
  readonly attachment: { readonly name: string; readonly content: Uint8Array };
}

/** Sends one email and classifies the response. Never throws: every failure is a SendOutcome. */
export interface EmailProvider {
  send(email: OutgoingEmail): Promise<SendOutcome>;
  /**
   * D50 (B6): outside production every email goes to this test mailbox instead of `to`. Recorded on each attempt, so a
   * bounce of the test mailbox does not suppress the real address.
   */
  readonly redirectsTo?: string;
}
