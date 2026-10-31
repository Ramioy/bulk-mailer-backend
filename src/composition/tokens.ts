/** Nest injection tokens; bound only in the composition root. */
export const AUTHENTICATOR = Symbol('Authenticator');
export const AUTH_USE_CASES = Symbol('AuthUseCases');
export const ADAPTERS = Symbol('Adapters');
export const RECEIPT_USE_CASES = Symbol('ReceiptUseCases');
export const EXECUTION_USE_CASES = Symbol('ExecutionUseCases');
export const SSE_HUB = Symbol('SseProgressHub');
export const JOB_RUNNER = Symbol('JobRunner');
export const OUTBOX_RELAY = Symbol('OutboxRelay');
export const DELIVERY_USE_CASES = Symbol('DeliveryUseCases');
export const ADMIN_USE_CASES = Symbol('AdminUseCases');
