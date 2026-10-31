# Bulk Mailer — Arquitectura (versión 2, aprobada el 2026-10-31)

Arquitectura acordada (hexagonal, monolito modular, una instancia) con las decisiones de `decisiones.md` aplicadas.
Identificadores en inglés. Los datos de negocio que ve el usuario final (nombres de archivo, `CNCPT`/`CNTRT`,
claves del catálogo de conceptos, asunto y cuerpo del correo) siguen en español.

## 1. Componentes

```mermaid
flowchart LR
    subgraph USR["🖥️ Operator environment"]
        HOST[("1. HOST MACHINE<br/>Payment receipts (PDF)")]
        WEB["2. WEB CLIENT<br/>Upload · review · send · progress"]
    end

    subgraph SVC["☁️ 3. SERVICE — single process (NestJS)"]
        direction LR
        subgraph IN["Inbound adapters"]
            REST["REST API<br/>(Bearer JWT)"]
            WH["Webhook reception<br/>POST /webhooks/zeptomail<br/>(ZeptoMail credentials: HMAC + header;<br/>no operator session, returns no data — D20)"]
            RUN["Job runner, four lanes (D21, D38, D41)<br/>execution: one batch at a time<br/>webhooks: delivery events<br/>lookups: reconciliation · sweep · checks<br/>files: deletion of receipt files"]
        end

        subgraph CORE["🧠 Core — domain + use cases (no infrastructure)"]
            UC["SignIn · UploadReceipts · RemoveReceipt<br/>GetBatchSummary · ExecuteBatch · ResendReceipt<br/>ResolveUncertain · ReleaseSuppressedAddress<br/>ReconcileSends · ProcessDeliveryEvent · VerifyDelivery · PurgeBatchFiles"]
            PORTS{{"Ports<br/>Authenticator · BulkMailerRepository · JobQueue · EventBus<br/>ReceiptFileStore · FileInspector · ContractSource<br/>EmailProvider · SendLookup · SuppressionManager<br/>ProgressNotifier · AlertNotifier · SecretStore · Clock"}}
        end

        subgraph OUT["Outbound adapters (initial)"]
            A_AUTH["LocalJwtAuthenticator"]
            A_PG["Postgres repository<br/>+ jobs table / outbox<br/>(FOR UPDATE SKIP LOCKED)"]
            A_FS["LocalVolumeFileStore"]
            A_INS["BasicPdfInspector"]
            A_SRC["TayronaContractSource<br/>SapContractSource"]
            A_ZM["ZeptoMailEmailProvider<br/>ZeptoMailSendLookup<br/>ZeptoMailConsoleSuppressionManager (D19)"]
            A_SSE["SseProgressNotifier"]
            A_AL["UiAlertNotifier"]
        end
    end

    PG[("PostgreSQL 18")]
    VOL[("💾 Volume /data<br/>PDFs until the batch is processed")]

    subgraph EXT["🌐 External services"]
        TAY["4a. TAYRONA contracts API"]
        SAP["4b. SAP contracts API"]
        ZM["5. ZOHO ZEPTOMAIL"]
    end
    DEST(["📧 Recipients"])

    HOST -- "operator selects files" --> WEB
    WEB -- "HTTPS + JWT" --> REST
    A_SSE -. "SSE progress" .-> WEB
    ZM -- "delivery events" --> WH
    REST & WH & RUN --> UC --> PORTS
    PORTS -.implemented by.- A_AUTH & A_PG & A_FS & A_INS & A_SRC & A_ZM & A_SSE & A_AL
    A_PG --> PG
    A_FS --> VOL
    A_SRC -- "GET /contratos/{contract}" --> TAY & SAP
    A_ZM -- "send · logs · suppressions" --> ZM
    ZM --> DEST
```

## 2. Puertos y adaptadores

| Port | Responsibility | Initial adapter | Future adapter |
|---|---|---|---|
| `Authenticator` | Sign in, issue and verify JWT (access 15 min, refresh 8 h), one role `operator` | `LocalJwtAuthenticator` (Argon2, accounts provisioned in DB) | AD / Entra ID |
| `BulkMailerRepository` | Receipts, attempts, manifests, batches, events, suppressions, alerts, audit. Receipts and batches carry a row version: a save based on a stale version fails (`ConcurrentModificationError`); manifests are insert-only (`DuplicateManifestVersionError`) (D37) | PostgreSQL 18 | — |
| `JobQueue` | Batch execution, reconciliation, delivery-event processing; recovery after crash; `hasPending` so periodic work is not queued twice (D38). A job can also be queued inside a repository transaction (`tx.jobs`, same table): it exists if and only if the transaction commits (D40) | Jobs table in PostgreSQL | Kafka / RabbitMQ |
| `EventBus` | Domain and progress events, at least once. An event that fails 10 deliveries is dead: it leaves the pending window, raises `OUTBOX_EVENT_DEAD` and can be retried by the operator (D39) | Outbox in PostgreSQL | Kafka |
| `ReceiptFileStore` | Save, read and purge PDFs by `(period, block, sha256)` | `LocalVolumeFileStore` (`/data`) | S3 / Azure Blob |
| `FileInspector` | Verdict on the file (see §2.1) | `BasicPdfInspector` | `QpdfClamAvInspector` |
| `ContractSource` | `get(contract)` → recipient | `TayronaContractSource` (blocks 1–4, 6) · `SapContractSource` (block 5) · `FakeContractSource` (non-prod) | — |
| `EmailProvider` | Send a message and classify the response | `ZeptoMailEmailProvider` | Another provider |
| `SendLookup` | Look up a send by `client_reference` | `ZeptoMailSendLookup` (logs API, OAuth) | — |
| `SuppressionManager` | Remove an address from the provider suppression list | `ZeptoMailConsoleSuppressionManager`: no API is documented, the operator removes it in the console and confirms it (D19) | `ZeptoMailSuppressionManager` (API), if Zoho confirms one |
| `ProgressNotifier` | Real-time progress | `SseProgressNotifier` | WebSocket |
| `AlertNotifier` | Deliver persisted typed alerts. The operator lists them newest first, filters them (`pending`, type, subject) and acknowledges them (D46) | `UiAlertNotifier` | Email / Teams / Slack |
| `SecretStore` | Credentials | Environment secrets manager | — |
| `Clock` | Current time, `America/Bogota` period, waits, reconciliation schedule | `SystemClock` | — |

Inbound adapters: REST API (JWT on every query and command), webhook reception (ZeptoMail's HMAC + custom header; no operator session and no data returned, D20), job runner with four lanes (D21, D38, D41): execution (one batch at a time), webhooks (never behind a lookup), lookups in the provider logs (reconciliation, sweep, per-minute check, at most `DELIVERY_CHECK_BATCH_SIZE` sends per check) and files (deletion of receipt files that are no longer needed, and the periodic orphan sweep). Every receipt change of every lane goes through the same serial executor.

### 2.1 `BasicPdfInspector` (verificación sencilla)

| # | Check | Rejection |
|---|---|---|
| 1 | Size ≤ 15 MB, checked before reading | `ATTACHMENT_TOO_LARGE` |
| 2 | `%PDF-1.x` / `%PDF-2.0` at byte 0 and `%%EOF` as last non-empty element | `NOT_A_PDF` |
| 3 | No `/Encrypt` entry | `PDF_ENCRYPTED` |
| 4 | Plain-text search of `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA`, `/SubmitForm` | `PDF_ACTIVE_CONTENT` |
| 5 | Number of `%%EOF` markers ≤ threshold + 1 (incremental revisions, default 0) | `PDF_INCREMENTAL_UPDATE` |

Known limitation: it does not see names that are obfuscated or hidden inside compressed streams, does not detect malformed files
built to exploit parsers, and runs no antivirus. That is what `QpdfClamAvInspector` covers when the service grows.

## 3. Secuencia — Carga

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant W as Web client
    participant API as Service · REST API
    participant INS as FileInspector
    participant FS as ReceiptFileStore (/data)
    participant SRC as ContractSource
    participant DB as PostgreSQL

    Op->>W: Chooses period + block, selects files from the host
    W->>API: POST /batches/{period}/{block}/receipts (Bearer JWT, multipart)
    API->>API: Verify JWT
    Note over API,SRC: Phase (a), outside the serial executor (D36)
    loop per file
        API->>API: sha256(content) · NFC name + regex + catalog + length (§4 of context)
        API->>INS: inspect(bytes)
        opt Name and file valid
            API->>SRC: GET /contratos/{contract} (once per contract)
        end
    end
    Note over API,DB: Phase (b), inside the serial executor, one transaction (D36, D37)
    API->>DB: No execution running (checked again)
    loop per file
        API->>DB: Does the hash already exist? (read now)
        alt Duplicate (rule §9 A1)
            API->>API: Discarded, not stored, not counted
        else New or re-evaluated
            API->>DB: Check local suppression list
            API->>FS: save(period, block, sha256)
            API->>DB: Receipt PENDING or INVALID (+ error type), optimistic version
        end
    end
    API->>DB: Batch OPEN · new manifest version (insert-only)
    API-->>W: Summary: accepted · invalid · discarded duplicates · manifest version
```

Every command follows the same two phases (D36): what calls an external service (contract sources, the inspector, the provider) runs outside the serial executor; inside it, one short transaction reads again the state the decision depends on, decides and writes. Refresh recipients, conflict resolution and resend work the same way; resend and the execution have three sections (record the attempt · call the provider outside · record the outcome).

## 4. Secuencia — Envío

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant W as Web client
    participant API as Service · REST API
    participant Q as JobQueue (PostgreSQL)
    participant R as Job runner
    participant FS as ReceiptFileStore
    participant SRC as ContractSource
    participant ZM as ZeptoMail
    participant DB as PostgreSQL

    Op->>W: Reviews the summary, presses "Send"
    W->>API: POST /batches/{period}/{block}/executions {manifestVersion}
    alt Version is not the current one
        API-->>W: 409 + differences (ADDED / REMOVED / RENAMED / RECIPIENT_CHANGED)
    else Another execution is running
        API-->>W: 409 EXECUTION_IN_PROGRESS
    else OK
        API->>DB: Batch RUNNING (global lock)
        API->>Q: Enqueue ExecuteBatch
        API-->>W: 202 Accepted {executionId}
    end
    W->>API: GET /executions/{executionId}/events (SSE)

    Q->>R: Take job (FOR UPDATE SKIP LOCKED)
    loop per manifest receipt, one at a time, with configurable pause
        R->>DB: Attempt (attemptId) + receipt SENDING
        R->>FS: read → bytes, recompute sha256
        R->>SRC: GET /contratos/{contract}
        R->>R: Same hash · same email as manifest · not suppressed
        R->>ZM: POST /v1.1/email (client_reference = attemptId)
        ZM-->>R: Response
        R->>DB: SENT / FAILED / UNCERTAIN / PENDING (SENT: file unavailable + DELETE_RECEIPT_FILE job, D41)
        R-->>W: Progress event (SSE)
        opt Uncertain response (1st or 2nd in a row)
            R-->>W: Wait event (reason, seconds, next send at) — before waiting
        end
    end
    alt Whole manifest processed
        R->>DB: Batch COMPLETED + PURGE_BATCH_FILES job (files of the processed receipts only, D42), same transaction
        Note over R,FS: The file lane deletes them after the commit (D41)
    else Batch error
        R->>DB: Batch STOPPED (+ reason) — files kept
    else Unexpected exception (D32)
        R->>DB: Receipt in progress UNCERTAIN (provider maybe called) or PENDING (not called)
        R->>DB: Batch STOPPED (INTERNAL_ERROR) — files kept, job marked failed
    else Shutdown signal, checked between receipts (D33)
        R->>DB: Receipt in progress recorded first, then Batch STOPPED (INTERRUPTED)
    end
    R-->>W: Final summary, failures grouped by type
```

- **Operator abort (D32):** `POST /executions/{executionId}/abort` `{ note, force? }` does for one execution what the recovery at startup does: its `SENDING` receipts become `UNCERTAIN` and it stops as `INTERRUPTED`. Refused (`409 EXECUTION_STILL_ACTIVE`) while the last progress event is younger than `EXECUTION_ABORT_AFTER_MINUTES` (a growing wait counts until its next send), unless forced. A run that was still alive notices it at its next write and takes no other receipt.
- **Shutdown (D33):** the job lanes stop before the HTTP server and the database close; each waits for its job in progress at most `SHUTDOWN_TIMEOUT_SECONDS`. Past that, the recovery at the next start covers what was left `SENDING`.

## 5. Estados del soporte (envío)

```mermaid
stateDiagram-v2
    [*] --> PENDING: valid file + recipient resolved
    [*] --> INVALID: name or file check failed
    INVALID --> PENDING: same hash re-uploaded with a valid name
    PENDING --> REMOVED: operator removes it
    INVALID --> REMOVED: operator removes it
    FAILED --> REMOVED: operator removes it
    REMOVED --> PENDING: same hash re-uploaded
    REMOVED --> INVALID: same hash re-uploaded with an invalid name
    PENDING --> SENDING: execution
    FAILED --> SENDING: new execution
    SENDING --> SENT: ZeptoMail accepts (EM_104)
    SENDING --> FAILED: error with certainty of no send (also a 400 with an unknown code, D28)
    SENDING --> PENDING: batch stopped before calling the provider, provider account rejection, or unexpected exception before calling it (D32)
    SENDING --> UNCERTAIN: timeout, 429, 5xx, undocumented non-400 response, crash, unexpected exception after calling the provider, operator abort (D32)
    UNCERTAIN --> SENT: provider confirms (logs or webhook)
    UNCERTAIN --> FAILED: not found at the provider
    FAILED --> SENT: late provider evidence, only for NOT_FOUND_AT_PROVIDER (D34)
    SENT --> SENDING: Resend (manual, after HARD_BOUNCE, COMPLAINT or PROCESS_FAILED, new email)
```

- `SENT` and `UNCERTAIN` never go to `REMOVED`.
- `FAILED → SENT` exists only for late evidence (webhook or logs) of the latest attempt of a receipt failed as `NOT_FOUND_AT_PROVIDER`; it raises `LATE_SEND_EVIDENCE` (D34). Any other `FAILED` is a certainty of no send and does not change.
- A failed resend ends in `FAILED` and enters the next normal manifest (D7c).

## 6. Estado de entrega (solo `SENT`)

```mermaid
stateDiagram-v2
    [*] --> UNCONFIRMED
    UNCONFIRMED --> SOFT_BOUNCE
    UNCONFIRMED --> ACCEPTED
    UNCONFIRMED --> HARD_BOUNCE
    UNCONFIRMED --> COMPLAINT: complaint without a prior acceptance event
    SOFT_BOUNCE --> ACCEPTED: provider retried successfully
    SOFT_BOUNCE --> HARD_BOUNCE: provider retries exhausted
    ACCEPTED --> COMPLAINT: recipient marked it as spam
    UNCONFIRMED --> PROCESS_FAILED: accepted, then not processed (logs only, D29)
    SOFT_BOUNCE --> PROCESS_FAILED: accepted, then not processed (logs only, D29)
```

The delivery state only advances. `ACCEPTED` = the recipient's server accepted it; not a guarantee of reaching the inbox.

## 7. Estado del lote

```mermaid
stateDiagram-v2
    [*] --> OPEN: first upload
    OPEN --> OPEN: upload / remove (new manifest version)
    OPEN --> RUNNING: send (current version)
    RUNNING --> COMPLETED: whole manifest processed → files of processed receipts purged (D42)
    STOPPED --> COMPLETED: settlement only: nothing ready, nothing SENDING or UNCERTAIN (D41)
    RUNNING --> STOPPED: batch error, unexpected exception (INTERNAL_ERROR), shutdown or operator abort (INTERRUPTED); files kept
    STOPPED --> RUNNING: send (current version)
    STOPPED --> OPEN: upload / remove
    COMPLETED --> OPEN: upload / remove
```

Only one execution at a time in the whole system. While it runs, upload, remove, send and resend are disabled.

`STOPPED → COMPLETED` exists only for settlement (D41): when whatever resolves a receipt of a stopped batch (a webhook, the logs, the operator) leaves it with nothing ready to send and nothing `SENDING` or `UNCERTAIN`, the batch completes (`BATCH_COMPLETED` event) and its processed files are purged. An `OPEN` batch is never closed automatically.

## 8. Catálogo de errores (inglés)

| Context (ES) | English | Kind |
|---|---|---|
| `NOMBRE_INVALIDO` | `INVALID_NAME` | File |
| `CONCEPTO_NO_CATALOGADO` | `UNKNOWN_CONCEPT` | File |
| `NOMBRE_DEMASIADO_LARGO` | `NAME_TOO_LONG` | File |
| `ADJUNTO_DEMASIADO_GRANDE` | `ATTACHMENT_TOO_LARGE` | File |
| — (D31) | `DUPLICATE_CONFLICT` | Same content under different names; blocked until the operator chooses |
| `ARCHIVO_NO_ES_PDF` | `NOT_A_PDF` | File |
| `PDF_CIFRADO` | `PDF_ENCRYPTED` | File |
| `PDF_CONTENIDO_ACTIVO` | `PDF_ACTIVE_CONTENT` | File |
| `PDF_MODIFICADO` | `PDF_INCREMENTAL_UPDATE` | File |
| `ARCHIVO_MALICIOSO` | `MALICIOUS_FILE` (only with the future inspector) | File |
| `DUPLICADO` | `DUPLICATE` (reported in the upload summary; not stored) | Upload |
| `ARCHIVO_NO_ACCESIBLE` | — (no shared drive) | — |
| — | `FILE_NOT_AVAILABLE` (file purged; re-upload needed) | Send |
| `CONTRATO_NO_EXISTE` | `CONTRACT_NOT_FOUND` | Recipient |
| `CONTRATO_INACTIVO` | `CONTRACT_INACTIVE` | Recipient |
| `CONTRATO_SIN_CORREO` | `CONTRACT_WITHOUT_EMAIL` | Recipient |
| `CORREO_SUPRIMIDO` | `EMAIL_SUPPRESSED` | Recipient |
| `FUENTE_NO_DISPONIBLE` | `SOURCE_UNAVAILABLE` ("could not query the source"; receipt `FAILED`, D7a) | Recipient / batch |
| `DESTINATARIO_CAMBIO` | `RECIPIENT_CHANGED` | Send |
| `ARCHIVO_MODIFICADO` | `FILE_MODIFIED` | Send |
| `PROVEEDOR_RECHAZO` | `PROVIDER_REJECTED` | Send |
| `PROVEEDOR_NO_DISPONIBLE` | `PROVIDER_UNAVAILABLE` | Send / batch |
| `NO_CONSTA_EN_PROVEEDOR` | `NOT_FOUND_AT_PROVIDER` | Send |
| `ERROR_INTERNO` | `INTERNAL_ERROR` | Send / batch |
| `PROVEEDOR_CUENTA` | `PROVIDER_ACCOUNT` | Batch |
| `AGENTE_NO_DISPONIBLE` | — (no agent) | — |
| `INTERRUMPIDO` | `INTERRUPTED` | Batch |
| `AUDITORIA_INMUTABLE` | `AUDIT_IMMUTABLE` | Audit |
| `WEBHOOKS_NO_RECIBIDOS` | `WEBHOOKS_NOT_RECEIVED` | Alert |
| — (D34) | `LATE_SEND_EVIDENCE` (a send failed as not found did go out; now SENT) | Alert |
| — (D34) | `DUPLICATE_SEND_DETECTED` (an older send believed not sent went out, and a later one too) | Alert |
| — (D39) | `OUTBOX_EVENT_DEAD` (a domain event could not be delivered after 10 attempts) | Alert |
| — (D41) | `FILE_PURGE_FAILED` (receipt files no receipt needs could not be deleted) | Alert |
| — (D43) | `UNCERTAIN_UNRESOLVED` (an uncertain send still unresolved after its last scheduled lookup) | Alert |
| — (D45) | `WEBHOOK_UNPARSED` (an authenticated webhook with no event of ours could be read) | Alert |
| `AGREGADO` / `EXCLUIDO` | `ADDED` / `REMOVED` | `409` difference |
| `RENOMBRADO` | `RENAMED` (same hash re-uploaded with another name) | `409` difference |
| `DESTINATARIO_CAMBIO` (409) | `RECIPIENT_CHANGED` (e.g. after *Refresh recipients*) | `409` difference |

## 9. Supuestos (aprobados el 2026-10-31)

| # | Supuesto |
|---|---|
| A1 | **Regla de repetidos.** Un hash que ya existe en cualquier lote o periodo se descarta como `DUPLICATE`, **excepto** si el registro existente es del mismo lote y está `INVALID`, `REMOVED` o `FAILED` sin archivo: en ese caso la carga reevalúa ese mismo registro (sirve para renombrar y para volver a subir tras la purga). Si el registro existente está `REMOVED` en **otro** lote o periodo, ese registro **se mueve** al lote nuevo y se reevalúa (D8). Nunca se crea un segundo registro |
| A2 | **Purga y reintentos.** Con los archivos borrados al completar el lote, reintentar un `FAILED` o hacer *Resend* tras un `HARD_BOUNCE` obliga a volver a subir el mismo PDF (regla A1). Hasta entonces el soporte muestra `FILE_NOT_AVAILABLE` y no entra al manifiesto. *Precisado por D41/D42:* el archivo se borra en cuanto el soporte queda `SENT` y, al completar el lote, solo los de soportes que pasaron por un envío; un `PENDING` o un soporte en conflicto lo conservan. El resumen muestra `fileError: FILE_NOT_AVAILABLE` junto al error propio del soporte |
| A3 | **Retirar soporte.** El operador puede retirar un soporte no enviado desde la interfaz (`DELETE`); sin esto no hay forma de corregir un nombre equivocado |
| A4 | **Destinatarios.** Se resuelven al cargar y se vuelven a consultar al enviar. Si cambió el correo, el soporte queda `FAILED / RECIPIENT_CHANGED`; para reintentarlo hace falta refrescar el destinatario (acción *Refresh recipients* del lote, que genera nueva versión de manifiesto) |
| A5 | **Periodo y bloques.** Periodo en formato `YYYY-MM` (p. ej. `2026-10`); bloques `CASH`, `AVVILLAS`, `BANCOLOMBIA`, `DAVIVIENDA`, `ANGLO`, `OTHERS`. Las claves del catálogo de conceptos siguen en español porque forman parte del nombre del archivo |
