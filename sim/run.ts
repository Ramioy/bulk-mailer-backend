/**
 * Simulated month (branch `simulacion`): drives the application over HTTPS exactly as the operator would, batch by
 * batch, and closes every batch with a report of what succeeded, what failed and how long it took. It does not fix
 * anything: every difference between what the design says (sim/out/data/expected.json) and what happened is listed.
 *
 * The report is read from the API and, for the details the API does not show (history, progress events, alerts
 * times), from PostgreSQL with read-only queries.
 *
 * Third month (after the audit, D32-D53): between the batches the month also exercises what the audit changed, end to
 * end and not only in unit tests: an upload over budget (413, D48); an execution aborted by the operator while the
 * provider keeps it waiting, whose stopped batch settles to COMPLETED and purges its files (D32, D41); late evidence of
 * a send given up as not found (D34); a webhook that cannot be read (D45); alerts resolved by the system versus
 * acknowledged by the operator (D46, D52); a shutdown (SIGTERM) in the middle of a batch → INTERRUPTED and a second
 * execution finishes it (D33), during which a webhook is lost so the hourly sweep must find it (D44); a second instance
 * that stays standby (D47); the manual release of retained files (D51). What this month cannot provoke from outside is
 * said so in the report (an exception inside the execution, D32).
 *
 * The runner cannot stop containers itself: it writes a request to SIM_CONTROL and sim/run.sh, on the host, runs the
 * `docker compose` command and marks it done.
 *
 * Env: APP_URL, APP2_URL, REPORT_DATABASE_URL, ZEPTO_URL, ZEPTO_OAUTH_TOKEN, ZEPTOMAIL_WEBHOOK_KEY,
 *      ZEPTOMAIL_WEBHOOK_AUTHORIZATION, SIM_OUT, SIM_CONTROL, APP_DATA_DIR, SIM_OPERATOR, SIM_OPERATOR_PASSWORD,
 *      ARCHIVE_COPY_ADDRESS, CLOSURE_SECONDS (300)
 */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';

/* oxlint-disable typescript/no-explicit-any -- untyped JSON from the API and the database; simulation script only */

import { BLOCKS, currentPeriod, NEW_CONCEPT, type SimFile } from './generate.ts';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const APP = env('APP_URL');
const APP2 = env('APP2_URL');
const OUT = env('SIM_OUT', 'sim/out');
const CONTROL = env('SIM_CONTROL', join(OUT, 'control'));
const APP_DATA = env('APP_DATA_DIR', '/appdata');
const CLOSURE_SECONDS = Number(env('CLOSURE_SECONDS', '300'));
const ARCHIVE = env('ARCHIVE_COPY_ADDRESS');
const PERIOD = currentPeriod();
const allFiles = JSON.parse(readFileSync(join(OUT, 'data', 'expected.json'), 'utf8')) as SimFile[];
/** The 300 files of the month; the extra ones belong to the audit scenarios. */
const files = allFiles.filter((f) => f.phase === undefined);
const extraFile = (scenario: string): SimFile => {
  const file = allFiles.find((f) => f.phase === 'extra' && f.scenario === scenario);
  if (!file) throw new Error(`extra file ${scenario} missing from expected.json`);
  return file;
};
const db = new Pool({ connectionString: env('REPORT_DATABASE_URL'), max: 2 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (from: Date | number | string, to: Date | number | string) => Math.round((new Date(to).getTime() - new Date(from).getTime()) / 100) / 10;
const log = (line: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
const nfc = (name: string) => name.normalize('NFC');

/** Polls `read` every `everyMs` until `done` says so or `maxMs` pass; returns the last value. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, maxMs: number, everyMs = 2000): Promise<T> {
  const deadline = Date.now() + maxMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(everyMs);
    value = await read();
  }
  return value;
}

// ---------------------------------------------------------------- API client (renews the 15 min access token)

interface Response<T = any> {
  readonly status: number;
  readonly body: T;
}

class Api {
  private access = '';
  private refreshToken = '';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async signIn(): Promise<void> {
    const r = await this.raw('POST', '/auth/sign-in', { username: env('SIM_OPERATOR'), password: env('SIM_OPERATOR_PASSWORD') }, false);
    if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`);
    this.access = r.body.accessToken;
    this.refreshToken = r.body.refreshToken;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    let r = await this.raw(method, path, body, true);
    if (r.status === 401 && r.body?.error === 'INVALID_ACCESS_TOKEN') {
      const renewed = await this.raw('POST', '/auth/refresh', { refreshToken: this.refreshToken }, false);
      if (renewed.status === 200) {
        this.access = renewed.body.accessToken;
        this.refreshToken = renewed.body.refreshToken;
      } else {
        await this.signIn();
      }
      r = await this.raw(method, path, body, true);
    }
    return r;
  }

  /** Like `call`, but a connection closed by the server (the 413 of D48 may close it before reading the rest) is a result, not a crash. */
  async tryCall<T = any>(method: string, path: string, body?: unknown): Promise<Response<T> | { readonly status: 0; readonly body: string }> {
    try {
      return await this.call<T>(method, path, body);
    } catch (error) {
      return { status: 0, body: `connection closed: ${String((error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message)}` };
    }
  }

  private async raw(method: string, path: string, body: unknown, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = auth ? { authorization: `Bearer ${this.access}` } : {};
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, ...(payload ? { body: payload } : {}) });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      // not JSON: kept as text
    }
    return { status: response.status, body: parsed };
  }
}

const health = async (baseUrl: string): Promise<{ status: number; body: any }> => {
  try {
    const r = await fetch(`${baseUrl}/health`);
    return { status: r.status, body: await r.json().catch(() => undefined) };
  } catch {
    return { status: 0, body: undefined };
  }
};

// ---------------------------------------------------------------- host control (sim/run.sh executes docker compose)

type HostAction = 'stop-app' | 'start-app' | 'start-app2' | 'stop-app2';

async function host(action: HostAction): Promise<number> {
  const name = `${Date.now()}-${action}`;
  writeFileSync(join(CONTROL, `${name}.request`), action);
  const done = join(CONTROL, `${name}.done`);
  const deadline = Date.now() + 180_000;
  while (!existsSync(done)) {
    if (Date.now() > deadline) throw new Error(`host action ${action} not done in 180 s (is sim/run.sh running?)`);
    await sleep(1000);
  }
  return Number(readFileSync(done, 'utf8').trim());
}

// ---------------------------------------------------------------- webhooks signed like ZeptoMail (mocks/zeptomail-api.ts)

/** Posts a webhook to the application with the real authentication (custom header + `producer-signature`). */
async function postSignedWebhook(payload: Record<string, unknown>): Promise<Response> {
  const json = JSON.stringify(payload);
  const s = createHmac('sha256', Buffer.from(env('ZEPTOMAIL_WEBHOOK_KEY'), 'utf8')).update(json, 'utf8').digest('base64');
  const response = await fetch(`${APP}/webhooks/zeptomail`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'producer-signature': `ts=${Date.now()};s=${encodeURIComponent(s)};s-algorithm=HmacSHA256`,
      authorization: env('ZEPTOMAIL_WEBHOOK_AUTHORIZATION'),
    },
    body: `data=${encodeURIComponent(json)}`,
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** The `email_delivered` event as the simulator shapes it, for an attempt the provider supposedly did accept. */
function deliveredWebhook(clientReference: string, recipient: string, subject: string): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    event_name: ['email_delivered'],
    event_message: [
      {
        email_info: {
          email_reference: `late-${randomUUID()}`,
          client_reference: clientReference,
          is_smtp_trigger: false,
          subject,
          bounce_address: '',
          from: { address: 'soportes@anutibara.com', name: '' },
          to: [{ email_address: { address: recipient, name: '' } }],
          processed_time: at,
          object: 'email',
        },
        event_data: [{ details: [{ delivered_to: recipient, time: at }], object: 'email_delivered' }],
        request_id: `late-${randomUUID().replaceAll('-', '')}`,
      },
    ],
    mailagent_key: 'sim-agent',
    webhook_request_id: randomUUID().replaceAll('-', ''),
  };
}

// ---------------------------------------------------------------- report

const report: string[] = [];
const json: Record<string, unknown>[] = [];
const allDifferences: string[] = [];
const notProvoked: string[] = [];
const write = () => {
  writeFileSync(join(OUT, 'report.md'), `${report.join('\n')}\n`);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(json, null, 2));
};
const md = (...lines: string[]) => {
  report.push(...lines);
  write();
};
const table = (head: string[], rows: Array<Array<string | number>>) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
const tally = (values: Array<string | undefined | null>) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? '—', (counts.get(v ?? '—') ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

/** A section of checks: every ❌ is also a difference of the month. */
class Checks {
  readonly lines: string[] = [];
  private readonly title: string;
  constructor(title: string) {
    this.title = title;
  }
  check(label: string, ok: boolean, detail: string): boolean {
    this.lines.push(`- ${ok ? '✅' : '❌'} ${label}: ${detail}`);
    if (!ok) allDifferences.push(`${this.title}: ${label}: ${detail}`);
    return ok;
  }
  note(text: string): void {
    this.lines.push(`- ℹ️ ${text}`);
  }
  finish(...intro: string[]): void {
    md(`## ${this.title}`, '', ...intro, ...(intro.length ? [''] : []), ...this.lines, '');
    log(`  ${this.title}: ${this.lines.filter((l) => l.startsWith('- ❌')).length} diferencias`);
  }
}

// ---------------------------------------------------------------- database reads (report only)

interface ReceiptRow {
  sha256: string;
  file_name: string;
  state: string;
  error_type: string | null;
  error_detail: string | null;
  delivery_state: string | null;
  recipient_email: string | null;
  file_available: boolean;
  version: number;
}

const RECEIPT_COLUMNS = 'sha256, file_name, state, error_type, error_detail, delivery_state, recipient_email, file_available, version';
const receiptsOf = async (block: string) => (await db.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE period = $1 AND block = $2`, [PERIOD, block])).rows;
const receiptNamed = async (block: string, fileName: string) => (await receiptsOf(block)).find((r) => r.file_name === nfc(fileName));
const receipt = async (sha256: string) => (await db.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE sha256 = $1`, [sha256])).rows[0];
const isPending = (r: ReceiptRow) => r.state === 'UNCERTAIN' || r.state === 'SENDING' || (r.state === 'SENT' && (r.delivery_state === 'UNCONFIRMED' || r.delivery_state === 'SOFT_BOUNCE'));
const batchRow = async (block: string) => (await db.query<{ state: string; stop_reason: string | null }>('SELECT state, stop_reason FROM batches WHERE period = $1 AND block = $2', [PERIOD, block])).rows[0];
const attemptsOf = async (sha256: string) => (await db.query<{ attempt_id: string; outcome: string; kind: string }>('SELECT attempt_id, outcome, kind FROM attempts WHERE sha256 = $1 ORDER BY seq', [sha256])).rows;
const historyOf = async (sha256: string) => (await db.query<{ event: string; detail: string | null }>('SELECT event, detail FROM receipt_history WHERE sha256 = $1 ORDER BY at', [sha256])).rows;
const filePath = (block: string, sha256: string) => join(APP_DATA, PERIOD, block, `${sha256}.pdf`);
const fileOnVolume = (block: string, sha256: string) => existsSync(filePath(block, sha256));
const subjectOf = async (sha256: string) => (await db.query<{ concept_key: string | null }>('SELECT concept_key FROM receipts WHERE sha256 = $1', [sha256])).rows[0]?.concept_key ?? '';

// ---------------------------------------------------------------- the month

const api = new Api(APP);

async function adminBefore(index: number): Promise<string[]> {
  const done: string[] = [];
  const step = async (label: string, method: string, path: string, body: unknown, expectStatus: number) => {
    const r = await api.call(method, path, body);
    const ok = r.status === expectStatus;
    done.push(`${ok ? '✅' : '❌'} ${label}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    if (!ok) allDifferences.push(`Administración antes del lote ${index + 1}: ${label} respondió ${r.status} (esperado ${expectStatus})`);
  };
  if (index === 2) await step(`agregar concepto ${NEW_CONCEPT}`, 'POST', '/concepts', { key: NEW_CONCEPT, subject: 'Sanción' }, 201);
  if (index === 3) {
    await step('cambiar el asunto de MULTA a «Multa por convivencia»', 'PATCH', '/concepts/MULTA', { subject: 'Multa por convivencia' }, 200);
    await step('activar la copia bcc', 'PUT', '/settings/archive-copy', { enabled: true }, 200);
  }
  if (index === 4) await step(`retirar el concepto ${NEW_CONCEPT}`, 'PATCH', `/concepts/${encodeURIComponent(NEW_CONCEPT)}`, { active: false }, 200);
  if (index === 5) await step('desactivar la copia bcc', 'PUT', '/settings/archive-copy', { enabled: false }, 200);
  return done;
}

function formOf(block: string, batchFiles: SimFile[]): FormData {
  const form = new FormData();
  for (const f of batchFiles) form.append('files', new Blob([readFileSync(join(OUT, 'pdfs', block, f.fileName))], { type: 'application/pdf' }), f.fileName);
  return form;
}

async function upload(block: string, batchFiles: SimFile[]) {
  const started = Date.now();
  const r = await api.call('POST', `/batches/${PERIOD}/${block}/receipts`, formOf(block, batchFiles));
  if (r.status !== 200) throw new Error(`upload ${block} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { results: r.body.results as Array<{ fileName: string; outcome: string; state?: string; errorType?: string }>, seconds: seconds(started, Date.now()), manifestVersion: r.body.manifestVersion as number };
}

/** D48: the 51st file of one request is refused with 413 and nothing of the request is registered. */
async function uploadBudget(block: string, batchFiles: SimFile[]): Promise<void> {
  const checks = new Checks(`Presupuesto de carga (D48), antes del lote 2`);
  const over = await api.tryCall('POST', `/batches/${PERIOD}/${block}/receipts`, formOf(block, [...batchFiles, extraFile('upload-budget')]));
  checks.check(
    `${batchFiles.length + 1} archivos en una sola petición con UPLOAD_MAX_FILES=50 → 413 UPLOAD_TOO_LARGE`,
    over.status === 413 && (over.body as any)?.error === 'UPLOAD_TOO_LARGE',
    over.status === 0 ? String(over.body) : `HTTP ${over.status} ${JSON.stringify(over.body)}`,
  );
  const rows = await receiptsOf(block);
  checks.check('nada quedó registrado en el lote', rows.length === 0, `${rows.length} soportes en ${block}`);
  const staging = join(APP_DATA, '.staging');
  checks.check('no quedan archivos en .staging del volumen', !existsSync(staging) || readdirCount(staging) === 0, existsSync(staging) ? `${readdirCount(staging)} entradas` : 'sin carpeta .staging');
  const again = await health(APP);
  checks.check('la app sigue sana después del 413', again.status === 200, `GET /health → ${again.status}`);
  checks.finish(`Se envían los 50 archivos del lote más uno extra (\`${extraFile('upload-budget').fileName}\`) en la misma petición; luego el lote se carga normalmente con sus 50.`);
}

function readdirCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

interface ExecutionStatus {
  executionId: string;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  stopReason?: string;
  counters: { processed: number; total: number };
  waiting?: { seconds: number; reason: string };
}

/** Follows an execution until it ends; `onProgress` may act in the middle (and tolerate the app being down meanwhile). */
async function follow(executionId: string, onProgress?: (status: ExecutionStatus) => Promise<void>): Promise<ExecutionStatus> {
  let lastLog = 0;
  for (;;) {
    let status: ExecutionStatus | undefined;
    try {
      const r = await api.call<ExecutionStatus>('GET', `/executions/${executionId}`);
      if (r.status === 200) status = r.body;
    } catch {
      // the app may be restarting (shutdown scenario): keep polling
    }
    if (status) {
      if (status.finishedAt) return status;
      if (Date.now() - lastLog > 20_000) {
        lastLog = Date.now();
        log(`  enviando: ${status.counters.processed}/${status.counters.total}${status.waiting ? ` (pausa ${status.waiting.seconds} s: ${status.waiting.reason})` : ''}`);
      }
      await onProgress?.(status);
    }
    await sleep(2000);
  }
}

async function startExecution(block: string, manifestVersion: number): Promise<Response> {
  return api.call('POST', `/batches/${PERIOD}/${block}/executions`, { manifestVersion });
}

interface BatchOptions {
  /** D33: stop the application (SIGTERM) once this many receipts were processed, then start it again and finish the batch. */
  readonly interruptAfter?: number;
}

async function runBatch(index: number, options: BatchOptions = {}): Promise<void> {
  const { block, day, source } = BLOCKS[index] as (typeof BLOCKS)[number];
  const batchFiles = files.filter((f) => f.block === block);
  const batchStarted = Date.now();
  log(`Lote ${index + 1}/6 ${block} (día ${day}, ${source}): ${batchFiles.length} archivos`);
  const admin = await adminBefore(index);
  if (index === 1) await uploadBudget(block, batchFiles);

  // 1. Upload, resolve the duplicate conflicts (D31: the operator keeps the original name) and review.
  const uploaded = await upload(block, batchFiles);
  for (const conflict of uploaded.results.filter((r) => r.outcome === 'DUPLICATE_CONFLICT')) {
    const duplicate = batchFiles.find((f) => nfc(f.fileName) === conflict.fileName);
    const original = duplicate?.duplicateOf ?? '(desconocido)';
    const resolved = await api.call('POST', `/receipts/${(conflict as { sha256?: string }).sha256}/resolve-conflict`, { fileName: nfc(original), note: 'Simulación: el nombre original es el correcto' });
    const ok = resolved.status === 200;
    admin.push(`${ok ? '✅' : '❌'} conflicto de duplicado (D31) \`${conflict.fileName}\` resuelto con el nombre original \`${original}\`: HTTP ${resolved.status}${ok ? '' : ` ${JSON.stringify(resolved.body)}`}`);
    if (!ok) allDifferences.push(`Lote ${index + 1} ${block}: resolver el conflicto de ${conflict.fileName} respondió ${resolved.status}`);
  }
  const summary = (await api.call('GET', `/batches/${PERIOD}/${block}`)).body;
  log(`  carga: ${uploaded.results.length} resultados en ${uploaded.seconds} s; listos ${summary.readyToSend.length}, por corregir ${summary.needsCorrection.length}`);

  // 2. Execute and follow it (twice when the shutdown scenario interrupts it).
  const start = await startExecution(block, summary.manifestVersion);
  if (start.status !== 202) {
    md(`## Lote ${index + 1}: ${block}`, '', `❌ No se pudo iniciar la ejecución: HTTP ${start.status} ${JSON.stringify(start.body)}`, '');
    allDifferences.push(`Lote ${index + 1} ${block}: no se pudo iniciar (${start.status})`);
    return;
  }
  const executions: ExecutionStatus[] = [];
  const shutdownLines: string[] = [];
  let interrupted = false;
  let status = await follow(start.body.executionId as string, async (s) => {
    if (options.interruptAfter === undefined || interrupted || s.counters.processed < options.interruptAfter) return;
    interrupted = true;
    await shutdownDuringBatch(block, s, shutdownLines);
  });
  executions.push(status);
  log(`  ejecución ${status.result}${status.stopReason ? ` / ${status.stopReason}` : ''} en ${seconds(status.startedAt, status.finishedAt as string)} s`);
  if (interrupted) {
    const checks = new Checks(`Apagado durante el lote ${index + 1} (D33)`);
    for (const line of shutdownLines) checks.lines.push(line);
    checks.check('la ejecución quedó STOPPED / INTERRUPTED', status.result === 'STOPPED' && status.stopReason === 'INTERRUPTED', `${status.result} / ${status.stopReason ?? '—'}`);
    const rows = await receiptsOf(block);
    checks.check('ningún soporte quedó SENDING', !rows.some((r) => r.state === 'SENDING'), `${rows.filter((r) => r.state === 'SENDING').length} en SENDING`);
    const uncertain = rows.filter((r) => r.state === 'UNCERTAIN').length;
    checks.note(`soportes UNCERTAIN tras el apagado: ${uncertain} (el apagado cooperativo deja terminar el envío en curso)`);
    const afterSummary = (await api.call('GET', `/batches/${PERIOD}/${block}`)).body;
    checks.check('el lote quedó STOPPED con soportes listos para una nueva ejecución', afterSummary.state === 'STOPPED' && afterSummary.readyToSend.length > 0, `estado ${afterSummary.state}, listos ${afterSummary.readyToSend.length}`);
    const resume = await startExecution(block, afterSummary.manifestVersion);
    checks.check('segunda ejecución aceptada (202) con el mismo manifiesto', resume.status === 202, `HTTP ${resume.status} ${JSON.stringify(resume.body)}`);
    checks.finish(`La app recibe SIGTERM (\`docker compose stop\`, periodo de gracia 40 s) con ${options.interruptAfter} soportes procesados; mientras está caída se pierde un webhook del lote 1 (lo debe hallar el barrido, D44). Luego arranca de nuevo y el operador lanza una segunda ejecución.`);
    if (resume.status === 202) {
      status = await follow(resume.body.executionId as string);
      executions.push(status);
      log(`  segunda ejecución ${status.result}${status.stopReason ? ` / ${status.stopReason}` : ''} en ${seconds(status.startedAt, status.finishedAt as string)} s`);
    }
  }
  const firstStarted = executions[0]?.startedAt as string;
  const lastFinished = status.finishedAt as string;

  // 3. Closure: wait until every send has a delivery result, or CLOSURE_SECONDS after the end.
  const closureDeadline = new Date(lastFinished).getTime() + CLOSURE_SECONDS * 1000;
  let rows = await receiptsOf(block);
  while (rows.some(isPending) && Date.now() < closureDeadline) {
    await sleep(10_000);
    rows = await receiptsOf(block);
  }
  const closedAt = Date.now();
  log(`  cierre: ${rows.filter(isPending).length} pendientes de entrega a los ${seconds(lastFinished, closedAt)} s del fin`);

  // 4. Compare with what the design expects.
  const history = new Map<string, string[]>();
  for (const h of (await db.query<{ sha256: string; event: string }>('SELECT sha256, event FROM receipt_history WHERE sha256 = ANY($1)', [rows.map((r) => r.sha256)])).rows) {
    history.set(h.sha256, [...(history.get(h.sha256) ?? []), h.event]);
  }
  const suppressed = new Set((await db.query<{ email: string }>('SELECT email FROM suppressions')).rows.map((r) => r.email));
  const byName = new Map(rows.map((r) => [r.file_name, r]));
  const outcomeByName = new Map(uploaded.results.map((r) => [r.fileName, r.outcome]));
  const differences: Array<{ file: SimFile; expected: string; actual: string }> = [];
  for (const file of batchFiles) {
    const name = nfc(file.fileName);
    const e = file.expected;
    const outcome = outcomeByName.get(name);
    const row = byName.get(name);
    const expected: string[] = [`carga ${e.upload}`];
    const actual: string[] = [`carga ${outcome ?? 'sin resultado'}`];
    if (e.upload === 'REGISTERED') {
      expected.push(`${e.state}${e.errorType ? ` / ${e.errorType}` : ''}${e.deliveryState ? ` / entrega ${e.deliveryState}` : ''}`);
      actual.push(row ? `${row.state}${row.error_type ? ` / ${row.error_type}` : ''}${row.delivery_state ? ` / entrega ${row.delivery_state}` : ''}` : 'sin registro');
      if (e.suppressed) {
        expected.push('dirección suprimida');
        actual.push(file.email && suppressed.has(file.email) ? 'dirección suprimida' : 'dirección NO suprimida');
      }
      if (e.historyEvent) {
        expected.push(`historial ${e.historyEvent}`);
        actual.push(row && history.get(row.sha256)?.includes(e.historyEvent) ? `historial ${e.historyEvent}` : `historial SIN ${e.historyEvent}`);
      }
    }
    if (expected.join(' · ') !== actual.join(' · ')) differences.push({ file, expected: expected.join(' · '), actual: actual.join(' · ') });
  }

  // 5. Timings from the stored progress events (of every execution of the batch).
  const executionIds = executions.map((e) => e.executionId);
  const events = (await db.query<{ type: string; at: Date; payload: any }>('SELECT type, at, payload FROM execution_events WHERE execution_id = ANY($1) ORDER BY seq', [executionIds])).rows;
  const resolved = events.filter((e) => e.type === 'DELIVERY_RESOLVED');
  const waits = resolved.map((e) => Number(e.payload.seconds));
  const incidentWaits = events.filter((e) => e.type === 'WAITING');
  const alerts = (await db.query<{ type: string; subject: string; detail: string }>('SELECT type, subject, detail FROM alerts WHERE raised_at >= $1 ORDER BY seq', [new Date(batchStarted)])).rows;
  const copy = (await db.query<{ copy_address: string | null }>('SELECT copy_address FROM executions WHERE execution_id = $1', [executionIds[0]])).rows[0]?.copy_address ?? null;
  const expectedCopy = index === 3 || index === 4 ? ARCHIVE : null;
  if (copy !== expectedCopy) differences.push({ file: { fileName: '(ejecución)', scenario: 'copia bcc' } as SimFile, expected: `copia ${expectedCopy ?? 'ninguna'}`, actual: `copia ${copy ?? 'ninguna'}` });

  let subjectCheck = '';
  if (index === 3) {
    const multa = (await db.query<{ attempt_id: string }>(
      "SELECT a.attempt_id FROM attempts a JOIN receipts r ON r.sha256 = a.sha256 WHERE r.period = $1 AND r.block = $2 AND r.concept_key = 'MULTA' AND a.outcome = 'ACCEPTED' LIMIT 1",
      [PERIOD, block],
    )).rows[0];
    if (multa) {
      const logs = await fetch(`${env('ZEPTO_URL')}/v1.1/email?client_reference=${multa.attempt_id}`, { headers: { authorization: `Zoho-oauthtoken ${env('ZEPTO_OAUTH_TOKEN')}` } });
      const subject = ((await logs.json()) as any)?.data?.[0]?.subject as string | undefined;
      const ok = subject?.includes('Multa por convivencia') === true;
      subjectCheck = `${ok ? '✅' : '❌'} Asunto de un correo de MULTA en ZeptoMail: «${subject ?? 'no encontrado'}»`;
      if (!ok) differences.push({ file: { fileName: '(correo MULTA)', scenario: 'asunto nuevo' } as SimFile, expected: 'asunto con «Multa por convivencia»', actual: subject ?? 'no encontrado' });
    }
  }

  // 6. D41: the files of the processed receipts are gone from the volume once the batch completed.
  const batch = await batchRow(block);
  const processedWithFile = rows.filter((r) => (r.state === 'SENT' || r.state === 'FAILED' || r.state === 'UNCERTAIN') && r.file_available);
  const stillOnVolume = rows.filter((r) => !r.file_available && fileOnVolume(block, r.sha256));
  const retained = rows.filter((r) => r.file_available);
  if (batch?.state === 'COMPLETED' && (processedWithFile.length > 0 || stillOnVolume.length > 0)) {
    differences.push({ file: { fileName: '(archivos)', scenario: 'retiro D41' } as SimFile, expected: 'ningún archivo de soporte procesado en el volumen', actual: `${processedWithFile.length} marcados disponibles, ${stillOnVolume.length} aún en el volumen` });
  }

  const processed = executions.reduce((a, e) => a + e.counters.processed, 0);
  const sendPhase = executions.reduce((a, e) => a + seconds(e.startedAt, e.finishedAt as string), 0);
  const total = seconds(batchStarted, closedAt);
  const sent = rows.filter((r) => r.state === 'SENT');
  md(
    `## Lote ${index + 1}/6: ${block} (día ${day} del mes, fuente ${source})`,
    '',
    ...(admin.length ? ['**Administración antes del lote**', '', ...admin.map((a) => `- ${a}`), ''] : []),
    ...executions.map((e, n) => `- Ejecución${executions.length > 1 ? ` ${n + 1}` : ''} \`${e.executionId}\`: **${e.result}${e.stopReason ? ` / ${e.stopReason}` : ''}**, ${e.counters.processed} procesados en ${seconds(e.startedAt, e.finishedAt as string)} s`),
    `- Lote: estado **${batch?.state ?? '—'}**${batch?.stop_reason ? ` / ${batch.stop_reason}` : ''}, versión de manifiesto ${summary.manifestVersion}, copia bcc: ${copy ?? 'no'}`,
    `- Carga: ${batchFiles.length} archivos en ${uploaded.seconds} s → registrados ${uploaded.results.filter((r) => r.outcome === 'REGISTERED').length}, conflictos de duplicado resueltos ${uploaded.results.filter((r) => r.outcome === 'DUPLICATE_CONFLICT').length}; listos para enviar ${summary.readyToSend.length}, por corregir ${summary.needsCorrection.length}`,
    `- Envío: ${processed} procesados en **${Math.round(sendPhase * 10) / 10} s** (${processed ? Math.round((sendPhase / processed) * 10) / 10 : 0} s por soporte)`,
    `- Espera de entrega: ${waits.length} esperas, promedio ${waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : 0} s, máximo ${waits.length ? Math.max(...waits) : 0} s; agotaron los 120 s: ${resolved.filter((e) => e.payload.result === 'TIMEOUT').length}`,
    `- Pausas por incidentes del proveedor: ${incidentWaits.length} (${incidentWaits.reduce((a, e) => a + Number(e.payload.seconds), 0)} s en total)`,
    `- Cierre: ${seconds(lastFinished, closedAt)} s después del envío; quedaron pendientes de entrega ${rows.filter(isPending).length}`,
    `- Archivos (D41): ${retained.length} conservados (${tally(retained.map((r) => r.state)).map(([s, n]) => `${s} ×${n}`).join(', ') || 'ninguno'}), ${rows.length - retained.length} retirados; en el volumen quedan ${rows.filter((r) => fileOnVolume(block, r.sha256)).length}`,
    `- **Duración total del lote: ${Math.round(total / 6) / 10} min** (${total} s)`,
    ...(subjectCheck ? [`- ${subjectCheck}`] : []),
    '',
    '**Resultado por estado**',
    '',
    ...table(['Estado / tipo de error / entrega', 'Soportes'], tally(rows.map((r) => `${r.state}${r.error_type ? ` / ${r.error_type}` : ''}${r.delivery_state ? ` / ${r.delivery_state}` : ''}`))),
    '',
    `Éxito (SENT entregado o con queja/rebote informado): ${sent.length} enviados de ${summary.readyToSend.length} listos; entregados (ACCEPTED) ${sent.filter((r) => r.delivery_state === 'ACCEPTED').length}.`,
    '',
    `**Alertas del lote** (${alerts.length}): ${alerts.length ? tally(alerts.map((a) => a.type)).map(([t, n]) => `${t} ×${n}`).join(', ') : 'ninguna'}`,
    '',
    differences.length === 0 ? '**Diferencias con lo esperado: ninguna.**' : `**Diferencias con lo esperado: ${differences.length}**`,
    '',
    ...(differences.length
      ? table(['Archivo', 'Escenario', 'Esperado', 'Ocurrió', 'Por qué se esperaba'], differences.map((d) => [d.file.fileName, d.file.scenario, d.expected, d.actual, d.file.expected?.why ?? '']))
      : []),
    '',
  );
  for (const d of differences) allDifferences.push(`Lote ${index + 1} ${block} · ${d.file.scenario} · ${d.file.fileName}: esperado «${d.expected}», ocurrió «${d.actual}»`);
  json.push({ batch: index + 1, block, executionIds, result: status.result, stopReason: status.stopReason, batchState: batch?.state, sendPhaseSeconds: sendPhase, totalSeconds: total, processed, waits, differences: differences.map((d) => ({ fileName: d.file.fileName, scenario: d.file.scenario, expected: d.expected, actual: d.actual })), startedAt: firstStarted });
  log(`  lote cerrado en ${total} s; diferencias: ${differences.length}`);
}

/** The receipt of batch 1 whose lost webhook the sweep must find (D44): chosen when the shutdown happens. */
let lostWebhook: { sha256: string; attemptId: string; fileName: string; emittedAt: number } | undefined;

/** D33: SIGTERM in the middle of a batch; while the app is down, a webhook of batch 1 is lost on purpose (D44). */
async function shutdownDuringBatch(block: string, status: ExecutionStatus, lines: string[]): Promise<void> {
  const push = (ok: boolean, label: string, detail: string) => {
    lines.push(`- ${ok ? '✅' : '❌'} ${label}: ${detail}`);
    if (!ok) allDifferences.push(`Apagado durante el lote ${block}: ${label}: ${detail}`);
  };
  log(`  apagado solicitado con ${status.counters.processed}/${status.counters.total} procesados`);
  const stoppedAt = Date.now();
  const stop = await host('stop-app');
  push(stop === 0, `\`docker compose stop app\` (SIGTERM) con ${status.counters.processed} procesados`, `terminó en ${seconds(stoppedAt, Date.now())} s, código ${stop}`);
  push((await health(APP)).status === 0, 'la app no responde mientras está detenida', `GET /health → ${(await health(APP)).status || 'sin conexión'}`);

  // A delivery webhook of batch 1 arrives while the app is down: lost. The logs do show it, so the hourly sweep must find it.
  const soft = files.find((f) => f.block === 'CASH' && f.scenario === 'softbounce') as SimFile;
  const row = await receiptNamed('CASH', soft.fileName);
  const accepted = row ? (await attemptsOf(row.sha256)).filter((a) => a.outcome === 'ACCEPTED').at(-1) : undefined;
  if (row && accepted) {
    const emitted = await fetch(`${env('ZEPTO_URL')}/__mock/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_reference: accepted.attempt_id, event: 'delivered' }) });
    const body = (await emitted.json().catch(() => undefined)) as { status?: string; webhook?: unknown } | undefined;
    const lost = emitted.status === 200 && body?.status === 'delivered' && body.webhook !== 200;
    push(lost, `el simulador entrega el rebote blando de \`${soft.fileName}\` (lote 1) y su webhook se pierde`, `estado en el simulador ${body?.status ?? '—'}, respuesta del webhook ${JSON.stringify(body?.webhook ?? null)}`);
    lostWebhook = { sha256: row.sha256, attemptId: accepted.attempt_id, fileName: soft.fileName, emittedAt: Date.now() };
  } else {
    push(false, 'soporte softbounce del lote 1 con intento aceptado', 'no encontrado');
  }

  const startedAt = Date.now();
  const start = await host('start-app');
  const healthy = await until(() => health(APP), (h) => h.status === 200, 120_000, 2000);
  push(start === 0 && healthy.status === 200, '`docker compose start app` y /health vuelve a 200', `en ${seconds(startedAt, Date.now())} s, código ${start}, health ${healthy.status}`);
  await api.signIn();
  const instance = await api.call('GET', '/instance');
  push(instance.status === 200 && instance.body?.role === 'leader', 'la instancia nueva toma el lease (leader)', `HTTP ${instance.status} ${JSON.stringify(instance.body)}`);
}

/** After batch 1: resend of a hard-bounced receipt, blocked while suppressed, then released and resent (§10.3, §10.4, D19). */
async function resendAndRelease(): Promise<void> {
  const file = files.find((f) => f.block === 'CASH' && f.scenario === 'hardbounce') as SimFile;
  const row = await receiptNamed('CASH', file.fileName);
  const checks = new Checks('Reenvío y liberación (después del lote 1)');
  if (!row) {
    checks.check('soporte con rebote duro del lote 1', false, 'no encontrado');
  } else {
    const again = await upload('CASH', [file]);
    checks.check('volver a subir el PDF (A2)', again.results[0]?.outcome === 'REGISTERED', JSON.stringify(again.results[0]));
    const blocked = await api.call('POST', `/receipts/${row.sha256}/resend`);
    checks.check('reenvío con la dirección suprimida → 409 EMAIL_SUPPRESSED', blocked.status === 409 && blocked.body?.error === 'EMAIL_SUPPRESSED', `HTTP ${blocked.status} ${JSON.stringify(blocked.body)}`);
    const released = await api.call('POST', `/suppressions/${encodeURIComponent(file.email as string)}/release`, { businessConfirmed: true, removedInProviderConsole: true, note: 'Simulación: el negocio confirmó la dirección' });
    checks.check('liberar la dirección (D19)', released.status === 200, `HTTP ${released.status} ${JSON.stringify(released.body)}`);
    const resent = await api.call('POST', `/receipts/${row.sha256}/resend`);
    checks.check('reenviar', resent.status === 200, `HTTP ${resent.status} ${JSON.stringify(resent.body)}`);
    // The simulated address bounces again (its scenario is in the address): the new attempt must end HARD_BOUNCE and suppressed.
    const after = await until(() => receipt(row.sha256), (r) => r?.delivery_state === 'HARD_BOUNCE', 60_000);
    const suppressedAgain = (await db.query('SELECT 1 FROM suppressions WHERE email = $1', [file.email])).rowCount === 1;
    checks.check('el reenvío vuelve a rebotar (la dirección simulada siempre rebota) y queda suprimida', after?.delivery_state === 'HARD_BOUNCE' && suppressedAgain, `${after?.state} / ${after?.delivery_state}, suprimida: ${suppressedAgain}`);
  }
  checks.finish(`Soporte: \`${file.fileName}\` → ${file.email}`);
}

/** After batch 1: abort while the provider keeps the send waiting (D32); the stopped batch settles and purges (D41). */
async function abortAndSettle(): Promise<void> {
  const file = extraFile('abort-settle');
  const checks = new Checks('Aborto del operador y asentamiento del lote (D32, D41), después del lote 1');
  const before = await batchRow('CASH');
  checks.note(`lote CASH antes: ${before?.state ?? '—'}`);
  const up = await upload('CASH', [file]);
  checks.check('subir un soporte nuevo al lote completado (vuelve a OPEN)', up.results[0]?.outcome === 'REGISTERED', JSON.stringify(up.results[0]));
  const summary = (await api.call('GET', `/batches/${PERIOD}/CASH`)).body;
  checks.check('el lote reabre con un solo soporte listo', summary.state === 'OPEN' && summary.readyToSend.length === 1, `estado ${summary.state}, listos ${summary.readyToSend.length}`);
  const start = await startExecution('CASH', summary.manifestVersion);
  checks.check('ejecución iniciada (202)', start.status === 202, `HTTP ${start.status} ${JSON.stringify(start.body)}`);
  if (start.status !== 202) return checks.finish();
  const executionId = start.body.executionId as string;
  const row = await receiptNamed('CASH', file.fileName);
  // The simulator holds this address 60 s before answering (ZEPTOMAIL_TIMEOUT_MS is 30 s): abort while the call is in flight.
  const sending = await until(() => receipt(row?.sha256 ?? ''), (r) => r?.state === 'SENDING', 30_000, 1000);
  checks.check('el soporte está SENDING (la llamada al proveedor está en curso)', sending?.state === 'SENDING', `${sending?.state ?? 'sin registro'}`);
  await sleep(4000);
  const tooSoon = await api.call('POST', `/executions/${executionId}/abort`, { note: 'Simulación: prueba sin force' });
  checks.check('abort sin `force` con progreso reciente → 409', tooSoon.status === 409, `HTTP ${tooSoon.status} ${JSON.stringify(tooSoon.body)}`);
  const aborted = await api.call('POST', `/executions/${executionId}/abort`, { note: 'Simulación: el operador aborta el envío que no avanza', force: true });
  checks.check('abort con `force` → 200, STOPPED / INTERRUPTED, un soporte UNCERTAIN', aborted.status === 200 && aborted.body?.stopReason === 'INTERRUPTED' && aborted.body?.uncertain?.length === 1, `HTTP ${aborted.status} ${JSON.stringify(aborted.body)}`);
  const status = (await api.call<ExecutionStatus>('GET', `/executions/${executionId}`)).body;
  checks.check('GET /executions/{id} lo muestra terminado STOPPED / INTERRUPTED', status.finishedAt !== undefined && status.result === 'STOPPED' && status.stopReason === 'INTERRUPTED', `${status.result} / ${status.stopReason}`);
  const released = await receipt(row?.sha256 ?? '');
  checks.check('el soporte quedó UNCERTAIN (liberado)', released?.state === 'UNCERTAIN', `${released?.state}`);
  const stopped = await batchRow('CASH');
  checks.check('el lote quedó STOPPED', stopped?.state === 'STOPPED', `${stopped?.state} / ${stopped?.stop_reason ?? '—'}`);
  const current = await api.call('GET', '/executions/current');
  checks.check('ninguna ejecución en curso (el cerrojo global se liberó): GET /executions/current muestra la última, ya terminada (D10)', current.status === 200 && current.body?.executionId === executionId && current.body?.finishedAt, `HTTP ${current.status} result ${current.body?.result}, finishedAt ${current.body?.finishedAt}`);

  // The provider did accept it (lost response): the reconciliation (1 min) or the late webhook makes it SENT, and the
  // batch, with nothing left to send or to resolve, settles to COMPLETED and retires its files.
  const settled = await until(() => batchRow('CASH'), (b) => b?.state === 'COMPLETED', 240_000, 5000);
  const final = await receipt(row?.sha256 ?? '');
  checks.check('la conciliación encuentra el envío: SENT / ACCEPTED', final?.state === 'SENT' && final?.delivery_state === 'ACCEPTED', `${final?.state} / ${final?.delivery_state ?? '—'}`);
  checks.check('el lote STOPPED sin nada pendiente se asienta a COMPLETED', settled?.state === 'COMPLETED', `${settled?.state} / ${settled?.stop_reason ?? '—'}`);
  const rows = await receiptsOf('CASH');
  const withFile = rows.filter((r) => r.file_available && (r.state === 'SENT' || r.state === 'FAILED' || r.state === 'UNCERTAIN'));
  const gone = await until(async () => !fileOnVolume('CASH', row?.sha256 ?? ''), (g) => g, 60_000, 2000);
  checks.check('el archivo del soporte se retiró del volumen (DELETE_RECEIPT_FILE)', gone && final?.file_available === false, `disponible=${final?.file_available}, en volumen=${!gone}`);
  checks.check('ningún soporte procesado del lote conserva archivo', withFile.length === 0, `${withFile.length} con archivo`);
  const purge = (await db.query<{ type: string; status: string }>("SELECT type, status FROM jobs WHERE type IN ('PURGE_BATCH_FILES','DELETE_RECEIPT_FILE') AND payload->>'block' = 'CASH' ORDER BY seq DESC LIMIT 5")).rows;
  checks.note(`trabajos de archivos del lote: ${tally(purge.map((j) => `${j.type} ${j.status}`)).map(([t, n]) => `${t} ×${n}`).join(', ') || 'ninguno registrado con block=CASH'}`);
  const stoppedAlert = (await api.call('GET', `/alerts?type=BATCH_STOPPED&resolved=true&limit=5`)).body as any[];
  checks.check('la alerta BATCH_STOPPED quedó resuelta por el sistema (resolvedAt)', Array.isArray(stoppedAlert) && stoppedAlert.some((a) => a.resolvedAt), JSON.stringify(stoppedAlert?.map((a) => ({ subject: a.subject, resolvedAt: a.resolvedAt, resolution: a.resolution }))));
  const hist = await historyOf(row?.sha256 ?? '');
  checks.note(`historial del soporte: ${hist.map((h) => h.event).join(' → ')}`);
  checks.finish(`Soporte extra \`${file.fileName}\` → ${file.email} (el simulador tarda 60 s en responder; la app corta a los 30 s).`);
}

/** D34: a send given up as NOT_FOUND_AT_PROVIDER whose delivery webhook arrives afterwards: FAILED → SENT, alerted, never resent. */
async function lateEvidence(): Promise<void> {
  const file = files.find((f) => f.block === 'AVVILLAS' && f.scenario === '503') as SimFile;
  const checks = new Checks('Evidencia tardía de un envío dado por no encontrado (D34), después del lote 2');
  const row = await receiptNamed('AVVILLAS', file.fileName);
  checks.check('el soporte 503 terminó FAILED / NOT_FOUND_AT_PROVIDER al cierre del lote', row?.state === 'FAILED' && row.error_type === 'NOT_FOUND_AT_PROVIDER', `${row?.state} / ${row?.error_type}`);
  if (!row) return checks.finish();
  const attempts = await attemptsOf(row.sha256);
  const last = attempts.at(-1);
  checks.note(`intentos antes: ${attempts.map((a) => `${a.kind} ${a.outcome}`).join(', ')}`);
  if (!last) return checks.finish();
  const posted = await postSignedWebhook(deliveredWebhook(last.attempt_id, file.email as string, await subjectOf(row.sha256)));
  checks.check('webhook `email_delivered` firmado para ese intento → 200', posted.status === 200, `HTTP ${posted.status} ${JSON.stringify(posted.body)}`);
  const after = await until(() => receipt(row.sha256), (r) => r?.state === 'SENT', 60_000);
  checks.check('FAILED → SENT / ACCEPTED (única transición permitida desde FAILED)', after?.state === 'SENT' && after?.delivery_state === 'ACCEPTED' && after.error_type === null, `${after?.state} / ${after?.delivery_state ?? '—'} / error ${after?.error_type ?? 'ninguno'}`);
  const alert = (await api.call('GET', `/alerts?type=LATE_SEND_EVIDENCE&subject=${row.sha256}`)).body as any[];
  checks.check('alerta LATE_SEND_EVIDENCE pendiente', Array.isArray(alert) && alert.length === 1 && !alert[0].acknowledgedAt, JSON.stringify(alert?.map((a) => ({ detail: a.detail, acknowledgedAt: a.acknowledgedAt }))));
  const dup = (await api.call('GET', `/alerts?type=DUPLICATE_SEND_DETECTED&subject=${row.sha256}`)).body as any[];
  checks.check('sin alerta DUPLICATE_SEND_DETECTED (no hubo segundo envío)', Array.isArray(dup) && dup.length === 0, `${dup?.length ?? '?'} alertas`);
  checks.check('ningún intento nuevo', (await attemptsOf(row.sha256)).length === attempts.length, `${(await attemptsOf(row.sha256)).length} intentos`);
  const hist = await historyOf(row.sha256);
  checks.check('historial con SENT confirmado tarde', hist.some((h) => h.event === 'SENT' && (h.detail ?? '').includes('late')), hist.map((h) => `${h.event}${h.detail ? ` (${h.detail})` : ''}`).join(' → '));
  checks.check('el archivo quedó retirado', after?.file_available === false && !fileOnVolume('AVVILLAS', row.sha256), `disponible=${after?.file_available}, en volumen=${fileOnVolume('AVVILLAS', row.sha256)}`);
  const batch = await batchRow('AVVILLAS');
  checks.note(`lote AVVILLAS: ${batch?.state}`);
  checks.finish(`Soporte \`${file.fileName}\` → ${file.email}: el simulador respondió 503 y nunca aceptó el correo; el guion firma un webhook \`email_delivered\` con el \`client_reference\` del intento, como si ZeptoMail lo hubiera aceptado después de todo.`);
}

/** D45: an authenticated webhook that says nothing usable raises WEBHOOK_UNPARSED (one per webhook). */
async function unparsedWebhook(): Promise<void> {
  const checks = new Checks('Webhook ilegible (D45), después del lote 2');
  const id = `sim-unparsed-${randomUUID().replaceAll('-', '')}`;
  const posted = await postSignedWebhook({ event_name: ['something_new'], event_message: [{ unexpected: true }], webhook_request_id: id });
  checks.check('webhook firmado con una forma desconocida → 200 (se acepta y se guarda)', posted.status === 200, `HTTP ${posted.status} ${JSON.stringify(posted.body)}`);
  const alert = await until(async () => (await api.call('GET', `/alerts?type=WEBHOOK_UNPARSED&subject=${id}`)).body as any[], (a) => Array.isArray(a) && a.length > 0, 30_000);
  checks.check('alerta WEBHOOK_UNPARSED con el webhook_request_id como sujeto', Array.isArray(alert) && alert.length === 1, JSON.stringify(alert?.map((a) => a.detail)));
  const stored = await api.call('GET', `/webhooks/zeptomail/events/${id}`);
  checks.check('el payload se puede consultar en GET /webhooks/zeptomail/events/{id}', stored.status === 200, `HTTP ${stored.status}`);
  const repeated = await postSignedWebhook({ event_name: ['something_new'], event_message: [{ unexpected: true }], webhook_request_id: id });
  const again = (await api.call('GET', `/alerts?type=WEBHOOK_UNPARSED&subject=${id}`)).body as any[];
  checks.check('el mismo webhook repetido no duplica la alerta', repeated.status === 200 && Array.isArray(again) && again.length === 1, `HTTP ${repeated.status}, ${again?.length} alertas`);
  const unsigned = await fetch(`${APP}/webhooks/zeptomail`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=%7B%7D' });
  checks.check('un webhook sin autenticación se rechaza', unsigned.status === 401 || unsigned.status === 403, `HTTP ${unsigned.status}`);
  checks.finish();
}

/** D46/D52: the operator acknowledges; the system resolves. Both are visible and distinct in GET /alerts. */
async function alertsReview(): Promise<void> {
  const checks = new Checks('Alertas: resueltas por el sistema y reconocidas por el operador (D46, D52), después del lote 3');
  const pending = (await api.call('GET', '/alerts?pending=true&resolved=false')).body as any[];
  checks.check('GET /alerts?pending=true&resolved=false responde la vista por defecto del cliente', Array.isArray(pending), `${pending?.length ?? '?'} alertas: ${tally(pending?.map((a) => a.type) ?? []).map(([t, n]) => `${t} ×${n}`).join(', ')}`);
  const late = pending?.find((a) => a.type === 'LATE_SEND_EVIDENCE');
  if (late) {
    const ack = await api.call('POST', `/alerts/${late.alertId}/acknowledge`, { note: 'Simulación: revisado, el correo sí salió' });
    checks.check('reconocer LATE_SEND_EVIDENCE → 200 con acknowledgedAt/By', ack.status === 200 && ack.body?.acknowledgedAt && ack.body?.acknowledgedBy, `HTTP ${ack.status} ${JSON.stringify({ acknowledgedAt: ack.body?.acknowledgedAt, acknowledgedBy: ack.body?.acknowledgedBy })}`);
    const twice = await api.call('POST', `/alerts/${late.alertId}/acknowledge`, {});
    checks.check('reconocerla de nuevo no es un error silencioso', twice.status !== 500, `HTTP ${twice.status} ${JSON.stringify(twice.body)}`);
    const after = (await api.call('GET', '/alerts?pending=true&resolved=false')).body as any[];
    checks.check('ya no aparece entre las pendientes', Array.isArray(after) && !after.some((a) => a.alertId === late.alertId), `${after?.length} pendientes`);
    const all = (await api.call('GET', `/alerts?type=LATE_SEND_EVIDENCE&subject=${late.subject}`)).body as any[];
    checks.check('sigue existiendo, reconocida, sin resolvedAt (el reconocimiento es del operador, no una resolución)', Array.isArray(all) && all.length === 1 && all[0].acknowledgedAt && !all[0].resolvedAt, JSON.stringify(all?.[0] && { acknowledgedAt: all[0].acknowledgedAt, resolvedAt: all[0].resolvedAt }));
  } else {
    checks.check('alerta LATE_SEND_EVIDENCE pendiente para reconocer', false, 'no está entre las pendientes');
  }
  const resolved = (await api.call('GET', '/alerts?resolved=true&limit=50')).body as any[];
  checks.check('las resueltas por el sistema traen resolvedAt y resolution', Array.isArray(resolved) && resolved.length > 0 && resolved.every((a) => a.resolvedAt && a.resolution), `${resolved?.length} resueltas: ${tally(resolved?.map((a) => a.type) ?? []).map(([t, n]) => `${t} ×${n}`).join(', ')}`);
  const stillPending = (await api.call('GET', '/alerts?pending=true&resolved=false')).body as any[];
  checks.check('ninguna resuelta aparece en la vista por defecto', Array.isArray(stillPending) && !stillPending.some((a) => a.resolvedAt), `${stillPending?.filter((a) => a.resolvedAt).length} resueltas entre las pendientes`);
  const hard = (await api.call('GET', '/alerts?type=HARD_BOUNCE&resolved=false&limit=100')).body as any[];
  checks.note(`HARD_BOUNCE sin resolver: ${hard?.length} (se resuelven al liberar la dirección, D19/D52)`);
  const ordered = Array.isArray(pending) && pending.every((a, i) => i === 0 || new Date(pending[i - 1].raisedAt).getTime() >= new Date(a.raisedAt).getTime());
  checks.check('más recientes primero', ordered, ordered ? 'orden descendente por raisedAt' : 'orden incorrecto');
  checks.finish();
}

/** D47: a second replica against the same database serves HTTP and stays standby. */
async function twoInstances(): Promise<void> {
  const checks = new Checks('Dos instancias (D47), después del lote 5');
  const before = await api.call('GET', '/instance');
  checks.check('la instancia principal es leader', before.status === 200 && before.body?.role === 'leader', JSON.stringify(before.body));
  const start = await host('start-app2');
  const healthy = await until(() => health(APP2), (h) => h.status === 200, 120_000, 2000);
  checks.check('la segunda instancia arranca y responde /health', start === 0 && healthy.status === 200, `código ${start}, health ${healthy.status}`);
  const api2 = new Api(APP2);
  let second: Response | undefined;
  try {
    await api2.signIn();
    second = await api2.call('GET', '/instance');
  } catch (error) {
    checks.check('la segunda instancia atiende HTTP con JWT', false, String(error));
  }
  if (second) {
    checks.check('la segunda instancia atiende HTTP con JWT (sign-in y GET /instance)', second.status === 200, `HTTP ${second.status}`);
    checks.check('la segunda queda standby y señala a la primera como titular del lease', second.body?.role === 'standby' && second.body?.leaseHolder === before.body?.instanceId, JSON.stringify(second.body));
    const summary2 = await api2.call('GET', `/batches/${PERIOD}/ANGLO`);
    checks.check('lee el mismo estado (lote ANGLO) que la primera', summary2.status === 200 && summary2.body?.state === (await api.call('GET', `/batches/${PERIOD}/ANGLO`)).body?.state, `estado ${summary2.body?.state}`);
  }
  await sleep(45_000); // more than one lease TTL: the first one keeps it
  const after = await api.call('GET', '/instance');
  checks.check('45 s después (más de un TTL) la primera sigue siendo leader', after.status === 200 && after.body?.role === 'leader' && after.body?.instanceId === before.body?.instanceId, JSON.stringify(after.body));
  const stop = await host('stop-app2');
  checks.check('la segunda instancia se retira', stop === 0, `código ${stop}`);
  checks.finish();
}

/** D51: files are kept indefinitely; the operator releases them by hand and the records stay. */
async function releaseFiles(): Promise<void> {
  const checks = new Checks('Liberación manual de archivos conservados (D51), después del lote 6');
  const block = 'OTHERS';
  const before = (await api.call('GET', `/batches/${PERIOD}/${block}`)).body;
  const withFile = (await receiptsOf(block)).filter((r) => r.file_available);
  checks.note(`soportes con archivo conservado antes: ${withFile.length} (${tally(withFile.map((r) => `${r.state}${r.error_type ? ` / ${r.error_type}` : ''}`)).map(([s, n]) => `${s} ×${n}`).join(', ')})`);
  const onVolumeBefore = withFile.filter((r) => fileOnVolume(block, r.sha256)).length;
  checks.check('esos archivos están en el volumen', onVolumeBefore === withFile.length, `${onVolumeBefore} de ${withFile.length}`);
  const bad = await api.call('POST', `/batches/${PERIOD}/${block}/release-files`, {});
  checks.check('sin nota → 400', bad.status === 400, `HTTP ${bad.status} ${JSON.stringify(bad.body)}`);
  const released = await api.call('POST', `/batches/${PERIOD}/${block}/release-files`, { note: 'Simulación: fin de mes, los PDF quedan en el servidor de archivos' });
  checks.check(`liberar → 200 con released=${withFile.length}`, released.status === 200 && released.body?.released === withFile.length, `HTTP ${released.status} ${JSON.stringify(released.body)}`);
  const gone = await until(async () => (await receiptsOf(block)).filter((r) => fileOnVolume(block, r.sha256)).length, (n) => n === 0, 60_000, 2000);
  checks.check('los archivos desaparecen del volumen (trabajo DELETE_RECEIPT_FILE)', gone === 0, `${gone} aún en el volumen`);
  const after = (await api.call('GET', `/batches/${PERIOD}/${block}`)).body;
  const rowsAfter = await receiptsOf(block);
  checks.check('los registros se conservan', rowsAfter.length === (await receiptsOf(block)).length && rowsAfter.length > 0 && after.needsCorrection.length === before.needsCorrection.length, `${rowsAfter.length} soportes, por corregir ${after.needsCorrection.length}`);
  const flagged = after.needsCorrection.filter((r: any) => r.fileError === 'FILE_NOT_AVAILABLE');
  checks.check('el resumen marca fileError FILE_NOT_AVAILABLE en los soportes por corregir, aparte de errorType', flagged.length === after.needsCorrection.filter((r: any) => r.state === 'PENDING').length && flagged.every((r: any) => r.errorType), `${flagged.length} marcados: ${tally(flagged.map((r: any) => r.errorType)).map(([t, n]) => `${t} ×${n}`).join(', ')}`);
  checks.check('el manifiesto avanzó (versión nueva)', released.body?.manifestVersion > before.manifestVersion, `${before.manifestVersion} → ${released.body?.manifestVersion}`);
  const again = await api.call('POST', `/batches/${PERIOD}/${block}/release-files`, { note: 'Simulación: segunda vez' });
  checks.note(`liberar de nuevo: HTTP ${again.status} ${JSON.stringify(again.body)}`);
  checks.finish();
}

/** D44: the webhook lost during the shutdown must be found by the hourly sweep (sends older than 1 h, every 5 min). */
async function sweepLostWebhook(): Promise<void> {
  const checks = new Checks('Barrido de un webhook perdido (D44), al final del mes');
  if (!lostWebhook) {
    checks.check('webhook perdido durante el apagado', false, 'el escenario del apagado no lo dejó');
    return checks.finish();
  }
  const sentAt = (await db.query<{ started_at: Date }>('SELECT started_at FROM attempts WHERE attempt_id = $1', [lostWebhook.attemptId])).rows[0]?.started_at;
  const eligibleAt = (sentAt ? sentAt.getTime() : lostWebhook.emittedAt) + 61 * 60_000;
  const deadline = eligibleAt + 7 * 60_000; // one sweep interval after the send turns 1 h old, plus margin
  const waitMinutes = Math.max(0, Math.round((deadline - Date.now()) / 6000) / 10);
  log(`  barrido: esperando hasta ${waitMinutes} min a que el envío de las ${sentAt?.toISOString() ?? '?'} cumpla 1 h y pase el barrido`);
  const before = await receipt(lostWebhook.sha256);
  checks.note(`antes del barrido: ${before?.state} / ${before?.delivery_state}`);
  const after = await until(() => receipt(lostWebhook!.sha256), (r) => r?.delivery_state === 'ACCEPTED', Math.max(0, deadline - Date.now()), 15_000);
  checks.check(`\`${lostWebhook.fileName}\` pasa de SOFT_BOUNCE a ACCEPTED sin webhook`, after?.state === 'SENT' && after?.delivery_state === 'ACCEPTED', `${after?.state} / ${after?.delivery_state}`);
  const events = (await db.query<{ source: string; state: string }>('SELECT source, state FROM delivery_events WHERE attempt_id = $1 ORDER BY seq', [lostWebhook.attemptId])).rows;
  checks.check('la entrega llegó por los logs (source LOGS), no por webhook', events.some((e) => e.source === 'LOGS' && e.state === 'ACCEPTED'), events.map((e) => `${e.source}:${e.state}`).join(', ') || 'sin eventos');
  const silence = (await api.call('GET', '/alerts?type=WEBHOOKS_NOT_RECEIVED&limit=10')).body as any[];
  checks.check('sin falsa alarma de silencio de webhooks (D46)', Array.isArray(silence) && silence.length === 0, `${silence?.length} alertas WEBHOOKS_NOT_RECEIVED`);
  checks.finish();
}

/** Month end: health, dead outbox events, failed jobs, leftovers. */
async function monthEnd(): Promise<void> {
  const checks = new Checks('Cierre del mes: salud, outbox, trabajos y sobrantes');
  const h = await health(APP);
  checks.check('GET /health → 200 ok (BD y volumen)', h.status === 200 && h.body?.status === 'ok', `HTTP ${h.status} ${JSON.stringify(h.body)}`);
  const dead = await api.call('GET', '/outbox/dead');
  checks.check('GET /outbox/dead: ningún evento muerto', dead.status === 200 && Array.isArray(dead.body?.events) && dead.body.events.length === 0, `HTTP ${dead.status} ${JSON.stringify(dead.body)}`);
  const outbox = (await db.query<{ n: string }>('SELECT count(*) AS n FROM outbox_events WHERE dispatched_at IS NULL')).rows[0]?.n;
  checks.check('outbox sin eventos por despachar', Number(outbox) === 0, `${outbox} pendientes`);
  const jobs = (await db.query<{ status: string; type: string; n: string }>('SELECT status, type, count(*) AS n FROM jobs GROUP BY status, type ORDER BY status, type')).rows;
  checks.check('ningún trabajo FAILED ni CLAIMED', !jobs.some((j) => j.status === 'FAILED' || j.status === 'CLAIMED'), jobs.map((j) => `${j.type} ${j.status} ×${j.n}`).join(', '));
  const leftovers = (await db.query<{ state: string; n: string }>("SELECT state, count(*) AS n FROM receipts WHERE period = $1 AND state IN ('SENDING','UNCERTAIN') GROUP BY state", [PERIOD])).rows;
  checks.check('ningún soporte SENDING ni UNCERTAIN al final del mes', leftovers.length === 0, leftovers.map((l) => `${l.state} ×${l.n}`).join(', ') || 'ninguno');
  const batches = (await db.query<{ block: string; state: string; stop_reason: string | null }>('SELECT block, state, stop_reason FROM batches WHERE period = $1 ORDER BY block', [PERIOD])).rows;
  checks.check('los seis lotes terminaron COMPLETED', batches.length === 6 && batches.every((b) => b.state === 'COMPLETED'), batches.map((b) => `${b.block} ${b.state}${b.stop_reason ? ` / ${b.stop_reason}` : ''}`).join(', '));
  const volume = (await db.query<{ n: string }>('SELECT count(*) AS n FROM receipts WHERE period = $1 AND file_available', [PERIOD])).rows[0]?.n;
  checks.note(`soportes con archivo conservado al final: ${volume} (por corregir de los lotes 1 a 5 y conflictos; OTHERS liberado a mano)`);
  const lease = await api.call('GET', '/instance');
  checks.check('una sola instancia, leader', lease.status === 200 && lease.body?.role === 'leader', JSON.stringify(lease.body));
  const unparsed = (await api.call('GET', '/alerts?type=WEBHOOK_UNPARSED&limit=50')).body as any[];
  checks.check('solo la alerta WEBHOOK_UNPARSED provocada (los webhooks reales del simulador se leen)', Array.isArray(unparsed) && unparsed.length === 1, `${unparsed?.length} alertas`);
  checks.finish();
}

const monthStarted = Date.now();
await api.signIn();
md(
  `# Simulación de un mes: ${PERIOD}`,
  '',
  `Inicio: ${new Date(monthStarted).toISOString()}. App en modo producción contra simuladores de Tayrona, SAP y ZeptoMail (Docker), código de \`main\` tras la auditoría (D32–D53).`,
  `Configuración: pausa entre envíos 1 s, espera de entrega hasta 120 s (consulta de logs cada 30 s), conciliación a 1/2/3 min, seguimiento 3 min después del lote, barrido de envíos de más de 1 h cada 5 min, cierre a más tardar ${CLOSURE_SECONDS} s después del envío, UPLOAD_MAX_FILES=50.`,
  '',
);
const scenarios: Array<{ name: string; run: () => Promise<void> }> = [];
const after = (name: string, run: () => Promise<void>) => scenarios.push({ name, run });
const runScenario = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    md(`## ${name}`, '', `❌ El guion falló: ${message}`, '');
    allDifferences.push(`${name}: el guion falló: ${message}`);
    log(`  ERROR en ${name}: ${message}`);
  }
};
for (let index = 0; index < BLOCKS.length; index += 1) {
  await runScenario(`Lote ${index + 1}: ${BLOCKS[index]?.block}`, () => runBatch(index, index === 3 ? { interruptAfter: 5 } : {}));
  scenarios.length = 0;
  if (index === 0) {
    after('Reenvío y liberación', resendAndRelease);
    after('Aborto y asentamiento', abortAndSettle);
  }
  if (index === 1) {
    after('Evidencia tardía', lateEvidence);
    after('Webhook ilegible', unparsedWebhook);
  }
  if (index === 2) after('Alertas', alertsReview);
  if (index === 4) after('Dos instancias', twoInstances);
  if (index === 5) {
    after('Liberación de archivos', releaseFiles);
    after('Barrido del webhook perdido', sweepLostWebhook);
    after('Cierre del mes', monthEnd);
  }
  for (const s of scenarios) await runScenario(s.name, s.run);
}
notProvoked.push(
  'Excepción inesperada dentro de la ejecución → `INTERNAL_ERROR` y liberación del soporte (D32): no se puede provocar desde fuera sin inyectar una falla en el proceso; queda cubierta por las pruebas unitarias (`run-execution.test.ts`). El camino del operador (`abort`) sí se ejercitó.',
  'Rebote duro cuyo webhook se perdió, hallado por el barrido (D44): el mes perdió a propósito un webhook de entrega (`delivered`), no de rebote; el camino por los logs es el mismo.',
  'Evento muerto del *outbox* y su reintento manual (D39): el bus no falló durante el mes, así que `GET /outbox/dead` quedó vacío y `POST /outbox/dead/{id}/retry` no se ejercitó.',
);
const audit = (await db.query<{ action: string }>('SELECT action FROM audit_entries WHERE at >= $1', [new Date(monthStarted)])).rows;
md(
  '## Resumen del mes',
  '',
  ...table(
    ['Lote', 'Bloque', 'Ejecuciones', 'Resultado', 'Lote al cierre', 'Envío (s)', 'Total (min)', 'Diferencias'],
    json.map((b) => [String(b.batch), String(b.block), String((b.executionIds as string[]).length), `${b.result}${b.stopReason ? ` / ${b.stopReason}` : ''}`, String(b.batchState ?? '—'), String(Math.round(Number(b.sendPhaseSeconds) * 10) / 10), String(Math.round(Number(b.totalSeconds) / 6) / 10), String((b.differences as unknown[]).length)]),
  ),
  '',
  `Duración total: ${Math.round(seconds(monthStarted, Date.now()) / 6) / 10} min. Auditoría registrada: ${tally(audit.map((a) => a.action)).map(([a, n]) => `${a} ×${n}`).join(', ')}.`,
  '',
  '### Lo que este mes no pudo provocar',
  '',
  ...notProvoked.map((n) => `- ${n}`),
  '',
  allDifferences.length ? `### Todas las diferencias (${allDifferences.length})` : '### Sin diferencias con lo esperado',
  '',
  ...allDifferences.map((d) => `- ${d}`),
  '',
);
log(`Fin. Informe en ${join(OUT, 'report.md')}; diferencias: ${allDifferences.length}`);
await db.end();
