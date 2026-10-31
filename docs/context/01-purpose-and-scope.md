# 1. Purpose and scope

Every month, the payment receipts for the administration fee and associated concepts (extra fee, fine) are emailed to the residential complexes. **One email is sent per receipt.** An operator runs the process manually, block by block, from a web interface. All processing happens in the backend.

Bulk Mailer is an in-house implementation. It sends through **Zoho ZeptoMail**, Zoho CPaaS's transactional email service (§12). It does not use or reuse `mail-service`.

**Design principles**

1. **No receipt reaches the wrong recipient.** The operator sees the recipient of every receipt before sending, and the system sends exactly what the operator reviewed.
2. **No receipt is sent twice without explicit intent.** Idempotency is Bulk Mailer's responsibility, because ZeptoMail does not provide it.
3. **There are no automatic retries.** Every repetition is decided by the operator, with the typed error in view.
4. **Permanent traceability** of every receipt, attempt and delivery event.
5. **Hexagonal architecture.** Every external system (shared drive, Tayrona, SAP, ZeptoMail, queue, authentication) sits behind a port and can be replaced without touching the domain.
