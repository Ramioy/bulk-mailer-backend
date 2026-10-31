import type { Alert } from '../domain/alert/alert';

/** Delivers an already persisted alert to one channel (the interface, for now). */
export interface AlertNotifier {
  notify(alert: Alert): Promise<void>;
}
