import type { Result } from '../domain/shared/result';

export interface Operator {
  readonly operatorId: string;
  readonly username: string;
}

export interface AuthenticatedOperator extends Operator {
  readonly sessionId: string;
  /** Long-lived connections (SSE) are closed at this instant; the client renews and reconnects. */
  readonly accessExpiresAt: Date;
}

export interface SessionTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  /** Absolute: not extended by activity. */
  readonly refreshExpiresAt: Date;
}

export interface SignedIn {
  readonly operator: Operator;
  readonly sessionId: string;
  readonly tokens: SessionTokens;
}

/** Sign-in distinguishes unknown user from wrong password; there is no lockout. */
export type SignInError = 'UNKNOWN_USER' | 'WRONG_PASSWORD';

export interface Authenticator {
  signIn(username: string, password: string): Promise<Result<SignedIn, SignInError>>;
  /** Rotates the refresh token; the session keeps its absolute expiry. */
  refresh(refreshToken: string): Promise<Result<SignedIn, 'INVALID_REFRESH_TOKEN'>>;
  /** Fails for expired tokens and for sessions that were signed out. */
  verify(accessToken: string): Promise<Result<AuthenticatedOperator, 'INVALID_ACCESS_TOKEN'>>;
  /** Ends the session of this refresh token. Returns the operator, or undefined if the token was unknown. */
  signOut(refreshToken: string): Promise<Operator | undefined>;
}
