import type { SendLookup, SendLookupResult } from '../../../ports/send-lookup';

export class FakeSendLookup implements SendLookup {
  private readonly results = new Map<string, SendLookupResult>();
  private unavailable = false;

  async findByAttempt(attemptId: string): Promise<SendLookupResult> {
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
