import type { AuditAction } from '../../domain/audit/audit';
import type { Result } from '../../domain/shared/result';
import type { Authenticator, Operator, SignedIn, SignInError } from '../../ports/authenticator';
import type { AuditLog } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';

export interface AuthDependencies {
  readonly authenticator: Authenticator;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly newId: () => string;
}

/** Sign-in, failed sign-in, renewal and sign-out are audited (docs/context/15-security-and-data.md). */
export class AuthUseCases {
  constructor(private readonly deps: AuthDependencies) {}

  async signIn(username: string, password: string): Promise<Result<SignedIn, SignInError>> {
    const result = await this.deps.authenticator.signIn(username, password);
    if (result.ok) {
      await this.record('SIGN_IN', result.value.operator.username, result.value.sessionId);
    } else {
      await this.record('SIGN_IN_FAILED', username, username, result.error);
    }
    return result;
  }

  async refresh(refreshToken: string): Promise<Result<SignedIn, 'INVALID_REFRESH_TOKEN'>> {
    const result = await this.deps.authenticator.refresh(refreshToken);
    if (result.ok) await this.record('SESSION_RENEWED', result.value.operator.username, result.value.sessionId);
    return result;
  }

  async signOut(refreshToken: string): Promise<Operator | undefined> {
    const operator = await this.deps.authenticator.signOut(refreshToken);
    if (operator) await this.record('SIGN_OUT', operator.username, operator.operatorId);
    return operator;
  }

  private async record(action: AuditAction, actor: string, subject: string, newValue?: string): Promise<void> {
    await this.deps.audit.append({ auditId: this.deps.newId(), actor, action, at: this.deps.clock.now(), subject, newValue });
  }
}
