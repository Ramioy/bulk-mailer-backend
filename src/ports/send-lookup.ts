export type ProviderSendStatus = 'QUEUED' | 'PROCESSED' | 'DELIVERED' | 'PROCESS_FAILED' | 'SOFT_BOUNCE' | 'HARD_BOUNCE';

export type SendLookupResult =
  | {
      readonly kind: 'FOUND';
      readonly status: ProviderSendStatus;
      readonly providerRequestId?: string;
      readonly emailReference?: string;
      readonly detail?: string;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly detail: string };

/**
 * Looks up a send in the provider logs by its client reference (the attempt id), as seen by one recipient
 * (the primary one: the copy's status never decides the receipt).
 */
export interface SendLookup {
  findByAttempt(attemptId: string, recipient: string): Promise<SendLookupResult>;
}
