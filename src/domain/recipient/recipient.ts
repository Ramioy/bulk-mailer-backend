import { RecipientErrorType } from '../shared/error-types';
import { err, ok, type Result } from '../shared/result';

/** What a contract source answered for `GET /contratos/{contract}`. */
export type ContractLookup =
  | {
      readonly kind: 'FOUND';
      readonly contract: string;
      readonly active: boolean;
      readonly complexName: string;
      readonly email: string | null;
    }
  | { readonly kind: 'NOT_FOUND' }
  /** Timeout, network error or 5xx. */
  | { readonly kind: 'UNAVAILABLE'; readonly detail: string };

export interface Recipient {
  readonly email: string;
  readonly complexName: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

/** Addresses are compared case-insensitively; the stored form is trimmed and lower-cased. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveRecipient(
  lookup: ContractLookup,
  isSuppressed: (email: string) => boolean,
): Result<Recipient, RecipientErrorType> {
  switch (lookup.kind) {
    case 'UNAVAILABLE':
      return err(RecipientErrorType.SOURCE_UNAVAILABLE);
    case 'NOT_FOUND':
      return err(RecipientErrorType.CONTRACT_NOT_FOUND);
    case 'FOUND': {
      if (!lookup.active) return err(RecipientErrorType.CONTRACT_INACTIVE);
      const email = lookup.email === null ? '' : normaliseEmail(lookup.email);
      if (!isValidEmail(email)) return err(RecipientErrorType.CONTRACT_WITHOUT_EMAIL);
      if (isSuppressed(email)) return err(RecipientErrorType.EMAIL_SUPPRESSED);
      return ok({ email, complexName: lookup.complexName });
    }
  }
}
