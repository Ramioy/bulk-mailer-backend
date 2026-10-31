# Bulk Mailer — backend

Sends monthly payment receipts (PDF) by email, one email per receipt, through Zoho ZeptoMail.
Hexagonal architecture (ports and adapters), modular monolith, single instance.

- Architecture: [`docs/architecture/arquitectura.md`](docs/architecture/arquitectura.md)
- Decisions: [`docs/architecture/decisiones.md`](docs/architecture/decisiones.md) — they override `docs/context/` where they differ
- Implementation plan: [`docs/architecture/plan-implementacion.md`](docs/architecture/plan-implementacion.md)
- Business context (as received): [`docs/context/`](docs/context/README.md)

## Toolchain

Node 26 · pnpm 12 · NestJS 12 on Fastify · TypeScript 7 · Vitest · oxlint · PostgreSQL 18 (Docker Compose for local work).

## Layout

```
src/
  domain/        entities, value objects, state machines — pure TypeScript
  ports/         interfaces the core needs from the outside
  application/   use cases
  adapters/
    inbound/     REST API, webhook endpoint, job runner
    outbound/    port implementations (PostgreSQL, volume, ZeptoMail, Tayrona, SAP, SSE…)
  config/        configuration loaded and validated at startup
  app.module.ts  composition root: the only place where ports are bound to adapters
test/
  architecture.test.ts  fails if domain/ports/application import infrastructure or outer layers
```

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm dev            # http://localhost:3000/health
```

## Database

```bash
pnpm db:up          # PostgreSQL 18 with two databases: bulk_mailer and bulk_mailer_test
pnpm db:migrate     # applies pending migrations to DATABASE_URL
```

Production roles (application user with insert-only audit): [`deploy/db/roles.sql`](deploy/db/roles.sql).

## Operator accounts

Bulk Mailer does not administer accounts and never ships default credentials. The deployment team provisions each one:

```bash
pnpm hash-password   # asks for the password (hidden), prints its argon2id hash
```

```sql
INSERT INTO operator_accounts (operator_id, username, password_hash) VALUES ('op-1', 'operador', '<hash>');
```

Secrets: `JWT_SIGNING_KEY` (base64, ≥ 32 bytes). TLS: `TLS_CERT_FILE` and `TLS_KEY_FILE`, required in production.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:db        # same tests plus PostgreSQL integration (reads TEST_DATABASE_URL from .env)
```

`pnpm test` skips the PostgreSQL integration tests when `TEST_DATABASE_URL` is not set; CI always sets it.
