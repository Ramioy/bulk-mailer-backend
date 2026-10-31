# adapters

- `inbound/`: REST API, webhook endpoint, job runner. They call use cases.
- `outbound/`: implementations of the ports (PostgreSQL, volume, ZeptoMail, Tayrona, SAP, SSE…).

Adapters are bound to ports only in the composition root (`src/app.module.ts`).
