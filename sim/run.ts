/**
 * Simulated month (branch `simulacion`): drives the application over HTTPS exactly as the operator would, batch by
 * batch, and closes every batch with a report of what succeeded, what failed and how long it took. It does not fix
 * anything: every difference between what the design says (sim/out/data/expected.json) and what happened is listed.
 *
 * The report is read from the API and, for the details the API does not show (history, progress events, alerts
 * times), from PostgreSQL with read-only queries.
 *
 * Env: APP_URL, REPORT_DATABASE_URL, ZEPTO_URL, ZEPTO_OAUTH_TOKEN, SIM_OUT, SIM_OPERATOR, SIM_OPERATOR_PASSWORD,
 *      ARCHIVE_COPY_ADDRESS, CLOSURE_SECONDS (300)
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
const OUT = env('SIM_OUT', 'sim/out');
const CLOSURE_SECONDS = Number(env('CLOSURE_SECONDS', '300'));
const ARCHIVE = env('ARCHIVE_COPY_ADDRESS');
const PERIOD = currentPeriod();
const files = JSON.parse(readFileSync(join(OUT, 'data', 'expected.json'), 'utf8')) as SimFile[];
const db = new Pool({ connectionString: env('REPORT_DATABASE_URL'), max: 2 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (from: Date | number, to: Date | number) => Math.round((new Date(to).getTime() - new Date(from).getTime()) / 100) / 10;
const log = (line: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);

// ---------------------------------------------------------------- API client (renews the 15 min access token)

interface Response<T = any> {
  readonly status: number;
  readonly body: T;
}

class Api {
  private access = '';
  private refreshToken = '';

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

  private async raw(method: string, path: string, body: unknown, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = auth ? { authorization: `Bearer ${this.access}` } : {};
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${APP}${path}`, { method, headers, ...(payload ? { body: payload } : {}) });
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

// ---------------------------------------------------------------- report

const report: string[] = [];
const json: Record<string, unknown>[] = [];
const allDifferences: string[] = [];
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

// ---------------------------------------------------------------- database reads (report only)

interface ReceiptRow {
  sha256: string;
  file_name: string;
  state: string;
  error_type: string | null;
  error_detail: string | null;
  delivery_state: string | null;
  recipient_email: string | null;
}

const receiptsOf = async (block: string) =>
  (await db.query<ReceiptRow>('SELECT sha256, file_name, state, error_type, error_detail, delivery_state, recipient_email FROM receipts WHERE period = $1 AND block = $2', [PERIOD, block])).rows;
const isPending = (r: ReceiptRow) => r.state === 'UNCERTAIN' || r.state === 'SENDING' || (r.state === 'SENT' && (r.delivery_state === 'UNCONFIRMED' || r.delivery_state === 'SOFT_BOUNCE'));

// ---------------------------------------------------------------- the month

const api = new Api();

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

async function upload(block: string, batchFiles: SimFile[]) {
  const form = new FormData();
  for (const f of batchFiles) form.append('files', new Blob([readFileSync(join(OUT, 'pdfs', block, f.fileName))], { type: 'application/pdf' }), f.fileName);
  const started = Date.now();
  const r = await api.call('POST', `/batches/${PERIOD}/${block}/receipts`, form);
  if (r.status !== 200) throw new Error(`upload ${block} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { results: r.body.results as Array<{ fileName: string; outcome: string; state?: string; errorType?: string }>, seconds: seconds(started, Date.now()), manifestVersion: r.body.manifestVersion as number };
}

async function runBatch(index: number): Promise<void> {
  const { block, day, source } = BLOCKS[index] as (typeof BLOCKS)[number];
  const batchFiles = files.filter((f) => f.block === block);
  const batchStarted = Date.now();
  log(`Lote ${index + 1}/6 ${block} (día ${day}, ${source}): ${batchFiles.length} archivos`);
  const admin = await adminBefore(index);

  // 1. Upload and review.
  const uploaded = await upload(block, batchFiles);
  const summary = (await api.call('GET', `/batches/${PERIOD}/${block}`)).body;
  log(`  carga: ${uploaded.results.length} resultados en ${uploaded.seconds} s; listos ${summary.readyToSend.length}, por corregir ${summary.needsCorrection.length}`);

  // 2. Execute and follow it.
  const start = await api.call('POST', `/batches/${PERIOD}/${block}/executions`, { manifestVersion: summary.manifestVersion });
  if (start.status !== 202) {
    md(`## Lote ${index + 1}: ${block}`, '', `❌ No se pudo iniciar la ejecución: HTTP ${start.status} ${JSON.stringify(start.body)}`, '');
    allDifferences.push(`Lote ${index + 1} ${block}: no se pudo iniciar (${start.status})`);
    return;
  }
  const executionId = start.body.executionId as string;
  let status: any;
  let lastLog = 0;
  for (;;) {
    status = (await api.call('GET', `/executions/${executionId}`)).body;
    if (status.finishedAt) break;
    if (Date.now() - lastLog > 20_000) {
      lastLog = Date.now();
      log(`  enviando: ${status.counters.processed}/${status.counters.total}${status.waiting ? ` (pausa ${status.waiting.seconds} s: ${status.waiting.reason})` : ''}`);
    }
    await sleep(2000);
  }
  log(`  ejecución ${status.result}${status.stopReason ? ` / ${status.stopReason}` : ''} en ${seconds(status.startedAt, status.finishedAt)} s`);

  // 3. Closure: wait until every send has a delivery result, or CLOSURE_SECONDS after the end.
  const closureDeadline = new Date(status.finishedAt).getTime() + CLOSURE_SECONDS * 1000;
  let rows = await receiptsOf(block);
  while (rows.some(isPending) && Date.now() < closureDeadline) {
    await sleep(10_000);
    rows = await receiptsOf(block);
  }
  const closedAt = Date.now();
  log(`  cierre: ${rows.filter(isPending).length} pendientes de entrega a los ${seconds(status.finishedAt, closedAt)} s del fin`);

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
    const name = file.fileName.normalize('NFC');
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

  // 5. Timings from the stored progress events.
  const events = (await db.query<{ type: string; at: Date; payload: any }>('SELECT type, at, payload FROM execution_events WHERE execution_id = $1 ORDER BY seq', [executionId])).rows;
  const resolved = events.filter((e) => e.type === 'DELIVERY_RESOLVED');
  const waits = resolved.map((e) => Number(e.payload.seconds));
  const incidentWaits = events.filter((e) => e.type === 'WAITING');
  const alerts = (await db.query<{ type: string; subject: string; detail: string }>('SELECT type, subject, detail FROM alerts WHERE raised_at >= $1 ORDER BY seq', [new Date(batchStarted)])).rows;
  const copy = (await db.query<{ copy_address: string | null }>('SELECT copy_address FROM executions WHERE execution_id = $1', [executionId])).rows[0]?.copy_address ?? null;
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

  const sendPhase = seconds(status.startedAt, status.finishedAt);
  const total = seconds(batchStarted, closedAt);
  const sent = rows.filter((r) => r.state === 'SENT');
  md(
    `## Lote ${index + 1}/6: ${block} (día ${day} del mes, fuente ${source})`,
    '',
    ...(admin.length ? ['**Administración antes del lote**', '', ...admin.map((a) => `- ${a}`), ''] : []),
    `- Ejecución \`${executionId}\`: **${status.result}${status.stopReason ? ` / ${status.stopReason}` : ''}**, versión de manifiesto ${summary.manifestVersion}, copia bcc: ${copy ?? 'no'}`,
    `- Carga: ${batchFiles.length} archivos en ${uploaded.seconds} s → registrados ${uploaded.results.filter((r) => r.outcome === 'REGISTERED').length}, duplicados descartados ${uploaded.results.filter((r) => r.outcome === 'DUPLICATE').length}; listos para enviar ${summary.readyToSend.length}, por corregir ${summary.needsCorrection.length}`,
    `- Envío: ${status.counters.processed} procesados en **${sendPhase} s** (${status.counters.processed ? Math.round((sendPhase / status.counters.processed) * 10) / 10 : 0} s por soporte)`,
    `- Espera de entrega: ${waits.length} esperas, promedio ${waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : 0} s, máximo ${waits.length ? Math.max(...waits) : 0} s; agotaron los 120 s: ${resolved.filter((e) => e.payload.result === 'TIMEOUT').length}`,
    `- Pausas por incidentes del proveedor: ${incidentWaits.length} (${incidentWaits.reduce((a, e) => a + Number(e.payload.seconds), 0)} s en total)`,
    `- Cierre: ${seconds(status.finishedAt, closedAt)} s después del envío; quedaron pendientes de entrega ${rows.filter(isPending).length}`,
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
    differences.length === 0
      ? '**Diferencias con lo esperado: ninguna.**'
      : `**Diferencias con lo esperado: ${differences.length}**`,
    '',
    ...(differences.length
      ? table(['Archivo', 'Escenario', 'Esperado', 'Ocurrió', 'Por qué se esperaba'], differences.map((d) => [d.file.fileName, d.file.scenario, d.expected, d.actual, d.file.expected?.why ?? '']))
      : []),
    '',
  );
  for (const d of differences) allDifferences.push(`Lote ${index + 1} ${block} · ${d.file.scenario} · ${d.file.fileName}: esperado «${d.expected}», ocurrió «${d.actual}»`);
  json.push({ batch: index + 1, block, executionId, result: status.result, stopReason: status.stopReason, sendPhaseSeconds: sendPhase, totalSeconds: total, counters: status.counters, waits, differences: differences.map((d) => ({ fileName: d.file.fileName, scenario: d.file.scenario, expected: d.expected, actual: d.actual })) });
  log(`  lote cerrado en ${total} s; diferencias: ${differences.length}`);
}

/** After batch 1: resend of a hard-bounced receipt, blocked while suppressed, then released and resent (§10.3, §10.4, D19). */
async function resendAndRelease(): Promise<void> {
  const file = files.find((f) => f.block === 'CASH' && f.scenario === 'hardbounce') as SimFile;
  const row = (await receiptsOf('CASH')).find((r) => r.file_name === file.fileName.normalize('NFC'));
  const lines: string[] = [];
  const check = (label: string, ok: boolean, detail: string) => {
    lines.push(`- ${ok ? '✅' : '❌'} ${label}: ${detail}`);
    if (!ok) allDifferences.push(`Reenvío/liberación: ${label}: ${detail}`);
  };
  if (!row) {
    check('soporte con rebote duro del lote 1', false, 'no encontrado');
  } else {
    const again = await upload('CASH', [file]);
    check('volver a subir el PDF (A2)', again.results[0]?.outcome === 'REGISTERED', JSON.stringify(again.results[0]));
    const blocked = await api.call('POST', `/receipts/${row.sha256}/resend`);
    check('reenvío con la dirección suprimida → 409 EMAIL_SUPPRESSED', blocked.status === 409 && blocked.body?.error === 'EMAIL_SUPPRESSED', `HTTP ${blocked.status} ${JSON.stringify(blocked.body)}`);
    const released = await api.call('POST', `/suppressions/${encodeURIComponent(file.email as string)}/release`, { businessConfirmed: true, removedInProviderConsole: true, note: 'Simulación: el negocio confirmó la dirección' });
    check('liberar la dirección (D19)', released.status === 200, `HTTP ${released.status} ${JSON.stringify(released.body)}`);
    const resent = await api.call('POST', `/receipts/${row.sha256}/resend`);
    check('reenviar', resent.status === 200, `HTTP ${resent.status} ${JSON.stringify(resent.body)}`);
    // The simulated address bounces again (its scenario is in the address): the new attempt must end HARD_BOUNCE and suppressed.
    let after: ReceiptRow | undefined;
    for (let i = 0; i < 30; i += 1) {
      await sleep(2000);
      after = (await receiptsOf('CASH')).find((r) => r.sha256 === row.sha256);
      if (after?.delivery_state === 'HARD_BOUNCE') break;
    }
    const suppressedAgain = (await db.query('SELECT 1 FROM suppressions WHERE email = $1', [file.email])).rowCount === 1;
    check('el reenvío vuelve a rebotar (la dirección simulada siempre rebota) y queda suprimida', after?.delivery_state === 'HARD_BOUNCE' && suppressedAgain, `${after?.state} / ${after?.delivery_state}, suprimida: ${suppressedAgain}`);
  }
  md('## Reenvío y liberación (después del lote 1)', '', `Soporte: \`${file.fileName}\` → ${file.email}`, '', ...lines, '');
}

const monthStarted = Date.now();
await api.signIn();
md(
  `# Simulación de un mes: ${PERIOD}`,
  '',
  `Inicio: ${new Date(monthStarted).toISOString()}. App en modo producción contra simuladores de Tayrona, SAP y ZeptoMail (Docker).`,
  `Configuración: pausa entre envíos 1 s, espera de entrega hasta 120 s (consulta de logs cada 30 s), conciliación a 1/2/3 min, seguimiento 3 min después del lote, cierre a más tardar ${CLOSURE_SECONDS} s después del envío.`,
  '',
);
for (let index = 0; index < BLOCKS.length; index += 1) {
  try {
    await runBatch(index);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    md(`## Lote ${index + 1}: ${BLOCKS[index]?.block}`, '', `❌ El guion falló: ${message}`, '');
    allDifferences.push(`Lote ${index + 1}: el guion falló: ${message}`);
    log(`  ERROR: ${message}`);
  }
  if (index === 0) await resendAndRelease();
}
const audit = (await db.query<{ action: string }>('SELECT action FROM audit_entries WHERE at >= $1', [new Date(monthStarted)])).rows;
md(
  '## Resumen del mes',
  '',
  ...table(
    ['Lote', 'Bloque', 'Resultado', 'Envío (s)', 'Total (min)', 'Diferencias'],
    json.map((b) => [String(b.batch), String(b.block), `${b.result}${b.stopReason ? ` / ${b.stopReason}` : ''}`, String(b.sendPhaseSeconds), String(Math.round(Number(b.totalSeconds) / 6) / 10), String((b.differences as unknown[]).length)]),
  ),
  '',
  `Duración total: ${Math.round(seconds(monthStarted, Date.now()) / 6) / 10} min. Auditoría registrada: ${tally(audit.map((a) => a.action)).map(([a, n]) => `${a} ×${n}`).join(', ')}.`,
  '',
  allDifferences.length ? `### Todas las diferencias (${allDifferences.length})` : '### Sin diferencias con lo esperado',
  '',
  ...allDifferences.map((d) => `- ${d}`),
  '',
);
log(`Fin. Informe en ${join(OUT, 'report.md')}; diferencias: ${allDifferences.length}`);
await db.end();
