import type { SendLookup } from '../../../ports/send-lookup';

/** Outside production every email went to the test mailbox (RedirectingEmailProvider): look it up there. */
export class RedirectingSendLookup implements SendLookup {
  constructor(
    private readonly inner: SendLookup,
    private readonly testMailbox: string,
  ) {}

  findByAttempt(attemptId: string, _recipient?: string) {
    return this.inner.findByAttempt(attemptId, this.testMailbox);
  }
}
