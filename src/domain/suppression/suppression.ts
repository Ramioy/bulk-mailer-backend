/** Local suppression list, fed by hard-bounce and complaint events. */
export interface Suppression {
  readonly email: string;
  readonly reason: 'HARD_BOUNCE' | 'COMPLAINT';
  readonly since: Date;
  readonly attemptId?: string;
}
