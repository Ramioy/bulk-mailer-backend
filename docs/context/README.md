# Business flow — Bulk Mailer (payment receipts for administrations)

> **Date:** 2026-10-30 · **Status:** functional design approved by the business area.
> English translation of `flujo-bulk-mailer.md`, split by section. Product identifiers (states, error
> types, directory names, port names, period format) are kept verbatim in Spanish: they are names, not prose.

| # | File | What it covers |
|---|---|---|
| 1 | [Purpose and scope](01-purpose-and-scope.md) | What Bulk Mailer does and the five design principles |
| 2 | [Glossary](02-glossary.md) | Period, block, batch, receipt, manifest, attempt, contract source, agent |
| 3 | [Periods, blocks and directories](03-periods-blocks-directories.md) | Shared-drive layout, the six blocks, operable periods, volume |
| 4 | [File name](04-file-name.md) | `CNCPT`/`CNTRT` format, validation rules and regex, examples, concept catalog |
| 5 | [File type validation](05-file-type-validation.md) | Why the signature is not enough; the eight on-premise controls and their rejection codes |
| 6 | [Receipt ↔ recipient matching](06-receipt-recipient-matching.md) | Contracts API contract (Tayrona/SAP), response mapping, verification moments |
| 7 | [State model](07-state-model.md) | Receipt identity by SHA-256; send, delivery and batch state machines |
| 8 | [Operational flow](08-operational-flow.md) | Synchronise, review, send and manual retry, with sequence diagrams |
| 9 | [Idempotency and uncertain sends](09-idempotency-and-uncertain-sends.md) | Guarantees, send-response classification, crash recovery, reconciliation |
| 10 | [Delivery, bounces and copies](10-delivery-bounces-copies.md) | Hard bounce, spam complaint, suppression, resend, archive copy (`bcc`) |
| 11 | [Error types](11-error-types.md) | File, recipient/send and batch error catalogs with operator actions |
| 12 | [Email provider: ZeptoMail](12-email-provider-zeptomail.md) | Account, credentials, message fields, error-code classes, webhooks, console, undocumented behaviours |
| 13 | [Interface: minimum information](13-ui-minimum-information.md) | What the UI must show and offer |
| 14 | [Architecture](14-architecture.md) | Deployment, ports and adapters table, on-premise agent |
| 15 | [Security and data](15-security-and-data.md) | Authentication, audit, personal data, retention, secrets, non-prod redirect |
| 16 | [Schedule and automation](16-schedule-and-automation.md) | Manual core; optional later automation |
| 17 | [Systems context](17-systems-context.md) | Tayrona, SAP, `mail-service` |
| 18 | [External pending items](18-external-pending-items.md) | Ten items that block the pilot, with owners |
| 19 | [References](19-references.md) | Zoho and file-security sources |

## Amendments

Decisions taken on 2026-10-30 to close points the original design left open. They are written into the sections named.

| # | Decision | Sections |
|---|---|---|
| 1 | Alerts go through a `NotificadorAlertas` port with registrable providers; the interface is the first and only provider for now. Alerts are always persisted | §13, §14.2 |
| 2 | "Current period" is computed in the `America/Bogota` time zone | §3 |
| 3 | Growing wait: base 30 s, then ×2, stop at the third consecutive incident; `Retry-After` honoured up to a 10-minute ceiling; every wait is reported to the interface before it starts | §8.3, §9.2.1, §13 |
| 4 | The `409` of *Send* carries a typed list of differences: `AGREGADO`, `EXCLUIDO`, `RENOMBRADO`, `DESTINATARIO_CAMBIO` | §8.3, §13 |
| 5 | Alert `WEBHOOKS_NO_RECIBIDOS` on proven loss or total silence after N hours | §9.4, §13 |
| 6 | Releasing an address is one atomic action of Bulk Mailer through the `GestorSupresiones` port: ZeptoMail first, local list only on confirmation | §10.3, §12.2, §12.7, §14.2 |
| 7 | Database engine: PostgreSQL 18; row locking with skip is `FOR UPDATE SKIP LOCKED` | §14.1, §14.2, §18 #7 |
| 8 | Authentication model: one role `operador`; accounts provisioned directly in the database with the hash printed by a backend command, no account administration in the product, never seeded credentials; TLS terminated by the backend; default lifetimes 15 min / 8 h; unknown user and wrong password are distinguished, no lockout. (Superseded the same day a two-role model with provisional passwords: dropped to keep the scope small) | §13, §15 |
| 9 | Audit: "reviewed" means the operator fetched the batch summary, recorded with its manifest version; sign-in, failed sign-in and renewal are audited; entries carry subject and evidence note, UTC instant with millisecond precision, and are append-only at product and storage level | §15 |
| 10 | Backend toolchain from the Sarian NestJS blueprint: pnpm, Node 26, NestJS 12 on Fastify, TypeORM on PostgreSQL 18, Vitest, oxlint; password hashing with Node's native `crypto.argon2`; PostgreSQL for integration tests via Docker Compose | `.claude/rules/services/backend.md` |
