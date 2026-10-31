import type { Result } from '../domain/shared/result';

export interface Operator {
  readonly operatorId: string;
  readonly username: string;
}

export interface SessionTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  /** Absolute: not extended by activity. */
  readonly refreshExpiresAt: Date;
}

/** Sign-in distinguishes unknown user from wrong password; there is no lockout. */
export type SignInError = 'UNKNOWN_USER' | 'WRONG_PASSWORD';

export interface Authenticator {
  signIn(username: string, password: string): Promise<Result<{ operator: Operator; tokens: SessionTokens }, SignInError>>;
  /** Issues a new access token; the refresh credential keeps its absolute expiry. */
  refresh(refreshToken: string): Promise<Result<{ operator: Operator; tokens: SessionTokens }, 'INVALID_REFRESH_TOKEN'>>;
  verify(accessToken: string): Promise<Result<Operator, 'INVALID_ACCESS_TOKEN'>>;
}
