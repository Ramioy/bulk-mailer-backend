import type { SendLookup, SendLookupResult } from '../../../ports/send-lookup';

export class FakeSendLookup implements SendLookup {
  private readonly results = new Map<string, SendLookupResult>();
  private unavailable = false;
  readonly calls: Array<{ attemptId: string; recipient: string }> = [];

  async findByAttempt(attemptId: string, recipient: string): Promise<SendLookupResult> {
    this.calls.push({ attemptId, recipient });
    if (this.unavailable) return { kind: 'UNAVAILABLE', detail: 'simulated outage' };
    return this.results.get(attemptId) ?? { kind: 'NOT_FOUND' };
  }

  setResult(attemptId: string, result: SendLookupResult): void {
    this.results.set(attemptId, result);
  }

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }
}
