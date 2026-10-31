import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { HttpContractSource } from '../adapters/outbound/contracts/http-contract-source';
import { FakeContractSource, type FakeContract } from '../adapters/outbound/fakes/fake-contract-source';
import { FakeEmailProvider } from '../adapters/outbound/fakes/fake-email-provider';
import { RedirectingEmailProvider } from '../adapters/outbound/zeptomail/redirecting-email-provider';
import { ZeptoMailEmailProvider } from '../adapters/outbound/zeptomail/zeptomail-email-provider';
import { RedirectingSendLookup } from '../adapters/outbound/zeptomail/redirecting-send-lookup';
import { ZeptoMailConsoleSuppressionManager } from '../adapters/outbound/zeptomail/zeptomail-console-suppression-manager';
import { ZeptoMailSendLookup } from '../adapters/outbound/zeptomail/zeptomail-send-lookup';
import { ZohoOAuthTokenProvider } from '../adapters/outbound/zeptomail/zoho-oauth';
import { FakeSendLookup } from '../adapters/outbound/fakes/fake-send-lookup';
import { FakeSuppressionManager } from '../adapters/outbound/fakes/fake-suppression-manager';
import type { ZeptoMailWebhookSecrets } from '../adapters/inbound/webhooks/zeptomail-webhook';
import { InProcessEventBus } from '../adapters/outbound/events/in-process-event-bus';
import { PostgresJobQueue } from '../adapters/outbound/postgres/postgres-job-queue';
import { SseProgressHub } from '../adapters/outbound/sse/sse-progress-hub';
import { UiAlertNotifier } from '../adapters/outbound/ui-alert-notifier';
import { BasicPdfInspector } from '../adapters/outbound/pdf/basic-pdf-inspector';
import { LocalVolumeFileStore } from '../adapters/outbound/volume/local-volume-file-store';
import { LocalJwtAuthenticator } from '../adapters/outbound/auth/local-jwt-authenticator';
import { PostgresOperatorAccountStore } from '../adapters/outbound/auth/postgres-operator-account-store';
import { createDataSource } from '../adapters/outbound/postgres/data-source';
import { PostgresBulkMailerRepository } from '../adapters/outbound/postgres/postgres-bulk-mailer-repository';
import { EnvSecretStore } from '../adapters/outbound/system/env-secret-store';
import { SystemClock } from '../adapters/outbound/system/system-clock';
import { DEFAULT_EMAIL_TEMPLATE, templateProblems, type EmailTemplate } from '../application/sending/email-template';
import type { AppConfig } from '../config/app-config';
import type { AlertNotifier } from '../ports/alert-notifier';
import type { Authenticator } from '../ports/authenticator';
import type { EmailProvider } from '../ports/email-provider';
import type { JobQueue } from '../ports/job-queue';
import type { BulkMailerRepository } from '../ports/bulk-mailer-repository';
import type { Clock } from '../ports/clock';
import type { ContractSources } from '../ports/contract-source';
import type { FileInspector } from '../ports/file-inspector';
import type { ReceiptFileStore } from '../ports/receipt-file-store';
import { MissingSecretError, type SecretStore } from '../ports/secret-store';
import type { SendLookup } from '../ports/send-lookup';
import type { SuppressionManager } from '../ports/suppression-manager';

/** Every adapter the application uses. Tests build their own set; production uses `buildAdapters`. */
export interface Adapters {
  readonly repository: BulkMailerRepository;
  readonly authenticator: Authenticator;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly fileStore: ReceiptFileStore;
  readonly fileInspector: FileInspector;
  readonly contractSources: ContractSources;
  readonly emailProvider: EmailProvider;
  readonly sendLookup: SendLookup;
  readonly suppressionManager: SuppressionManager;
  /** Webhook authentication; without it the webhook endpoint answers 404. */
  readonly webhookSecrets?: ZeptoMailWebhookSecrets;
  readonly jobQueue: JobQueue;
  /** Progress fan-out to SSE streams; also the ProgressNotifier adapter. */
  readonly progressHub: SseProgressHub;
  /** Delivery side of the outbox; in-process for now, Kafka in the future. */
  readonly eventBus: InProcessEventBus;
  /** Registered alert providers; the interface is the only one for now. */
  readonly alertNotifiers: readonly AlertNotifier[];
  /** Releases connections on shutdown. */
  close(): Promise<void>;
}

export const JWT_SIGNING_KEY_SECRET = 'JWT_SIGNING_KEY';

/** The default template, or the one in EMAIL_TEMPLATE_FILE; refuses to start with an invalid template. */
export function loadEmailTemplate(config: AppConfig): EmailTemplate {
  if (!config.emailTemplateFile) return DEFAULT_EMAIL_TEMPLATE;
  const template = JSON.parse(readFileSync(config.emailTemplateFile, 'utf8')) as EmailTemplate;
  const problems = templateProblems(template);
  if (problems.length > 0) throw new Error(`Invalid EMAIL_TEMPLATE_FILE:\n- ${problems.join('\n- ')}`);
  return template;
}

/** Decodes the base64 signing key from the secret store. */
export async function loadSigningKey(secrets: SecretStore): Promise<Buffer> {
  const key = Buffer.from(await secrets.get(JWT_SIGNING_KEY_SECRET), 'base64');
  if (key.length < 32) throw new Error(`${JWT_SIGNING_KEY_SECRET} must decode to at least 32 bytes (base64)`);
  return key;
}

export const ZEPTOMAIL_API_KEY_SECRET = 'ZEPTOMAIL_API_KEY';

/** ZeptoMail (always wrapped by the test-mailbox redirect outside production) or, outside production, simulated. */
async function emailProvider(config: AppConfig, secrets: SecretStore): Promise<EmailProvider> {
  const provider: EmailProvider =
    config.emailProvider === 'zeptomail' && config.zeptomail
      ? new ZeptoMailEmailProvider({
          baseUrl: config.zeptomail.baseUrl,
          apiKey: await secrets.get(ZEPTOMAIL_API_KEY_SECRET),
          from: { address: config.zeptomail.fromAddress, ...(config.zeptomail.fromName ? { name: config.zeptomail.fromName } : {}) },
          bounceAddress: config.zeptomail.bounceAddress,
          timeoutMs: config.zeptomail.timeoutMs,
        })
      : new FakeEmailProvider();
  return config.redirectAllEmailTo ? new RedirectingEmailProvider(provider, config.redirectAllEmailTo) : provider;
}

export const ZOHO_OAUTH_CLIENT_ID_SECRET = 'ZOHO_OAUTH_CLIENT_ID';
export const ZOHO_OAUTH_CLIENT_SECRET_SECRET = 'ZOHO_OAUTH_CLIENT_SECRET';
export const ZOHO_OAUTH_REFRESH_TOKEN_SECRET = 'ZOHO_OAUTH_REFRESH_TOKEN';
export const ZEPTOMAIL_WEBHOOK_KEY_SECRET = 'ZEPTOMAIL_WEBHOOK_KEY';
export const ZEPTOMAIL_WEBHOOK_AUTHORIZATION_SECRET = 'ZEPTOMAIL_WEBHOOK_AUTHORIZATION';

/**
 * Delivery tracking (§9.4, §10.3): with ZeptoMail, the logs API over OAuth (looked up in the test mailbox outside
 * production) and the console release confirmed by the operator (D19); simulated otherwise.
 */
async function deliveryTracking(config: AppConfig, secrets: SecretStore): Promise<Pick<Adapters, 'sendLookup' | 'suppressionManager'>> {
  if (config.emailProvider !== 'zeptomail' || !config.zeptomail) return { sendLookup: new FakeSendLookup(), suppressionManager: new FakeSuppressionManager() };
  const tokens = new ZohoOAuthTokenProvider({
    accountsUrl: config.zeptomail.accountsUrl,
    clientId: await secrets.get(ZOHO_OAUTH_CLIENT_ID_SECRET),
    clientSecret: await secrets.get(ZOHO_OAUTH_CLIENT_SECRET_SECRET),
    refreshToken: await secrets.get(ZOHO_OAUTH_REFRESH_TOKEN_SECRET),
    timeoutMs: config.zeptomail.timeoutMs,
  });
  const lookup = new ZeptoMailSendLookup({ baseUrl: config.zeptomail.baseUrl, timeoutMs: config.zeptomail.timeoutMs }, tokens);
  return {
    sendLookup: config.redirectAllEmailTo ? new RedirectingSendLookup(lookup, config.redirectAllEmailTo) : lookup,
    suppressionManager: new ZeptoMailConsoleSuppressionManager(),
  };
}

/** Webhook secrets: required with ZeptoMail; optional otherwise (local tests against the simulator). */
export async function webhookSecrets(config: AppConfig, secrets: SecretStore): Promise<ZeptoMailWebhookSecrets | undefined> {
  try {
    return {
      authenticationKey: await secrets.get(ZEPTOMAIL_WEBHOOK_KEY_SECRET),
      authorizationHeader: config.webhookAuthHeader,
      authorizationValue: await secrets.get(ZEPTOMAIL_WEBHOOK_AUTHORIZATION_SECRET),
      maxSkewSeconds: config.webhookMaxSkewSeconds,
    };
  } catch (error) {
    if (error instanceof MissingSecretError && config.emailProvider !== 'zeptomail') return undefined;
    throw error;
  }
}

export const TAYRONA_API_TOKEN_SECRET = 'TAYRONA_API_TOKEN';
export const SAP_API_TOKEN_SECRET = 'SAP_API_TOKEN';

/**
 * Tayrona and SAP contracts APIs over HTTP, or (outside production) simulated sources optionally loaded from
 * `{ "TAYRONA": { "<contract>": { complexName, email, active? } }, "SAP": { … } }`.
 */
async function contractSources(config: AppConfig, secrets: SecretStore): Promise<ContractSources> {
  if (config.contractSource === 'http') {
    const timeoutMs = config.contractApiTimeoutMs;
    return {
      TAYRONA: new HttpContractSource({ baseUrl: config.tayronaApiUrl as string, token: await secrets.get(TAYRONA_API_TOKEN_SECRET), timeoutMs }),
      SAP: new HttpContractSource({ baseUrl: config.sapApiUrl as string, token: await secrets.get(SAP_API_TOKEN_SECRET), timeoutMs }),
    };
  }
  const data = config.fakeContractsFile
    ? (JSON.parse(readFileSync(config.fakeContractsFile, 'utf8')) as Partial<Record<'TAYRONA' | 'SAP', Record<string, FakeContract>>>)
    : {};
  return { TAYRONA: new FakeContractSource(data.TAYRONA ?? {}), SAP: new FakeContractSource(data.SAP ?? {}) };
}

export async function buildAdapters(config: AppConfig, secrets: SecretStore = new EnvSecretStore()): Promise<Adapters> {
  const sources = await contractSources(config, secrets);
  const clock = new SystemClock();
  const dataSource = await createDataSource(config.databaseUrl).initialize();
  const authenticator = new LocalJwtAuthenticator(new PostgresOperatorAccountStore(dataSource), clock, {
    signingKey: await loadSigningKey(secrets),
    accessTokenMinutes: config.accessTokenMinutes,
    sessionHours: config.sessionHours,
  });
  return {
    repository: new PostgresBulkMailerRepository(dataSource),
    authenticator,
    clock,
    newId: randomUUID,
    fileStore: new LocalVolumeFileStore(config.dataDir),
    fileInspector: new BasicPdfInspector({ maxIncrementalUpdates: config.pdfMaxIncrementalUpdates }),
    contractSources: sources,
    emailProvider: await emailProvider(config, secrets),
    ...(await deliveryTracking(config, secrets)),
    webhookSecrets: await webhookSecrets(config, secrets),
    jobQueue: new PostgresJobQueue(dataSource, () => clock.now()),
    progressHub: new SseProgressHub(),
    eventBus: new InProcessEventBus(),
    alertNotifiers: [new UiAlertNotifier()],
    close: () => dataSource.destroy(),
  };
}
