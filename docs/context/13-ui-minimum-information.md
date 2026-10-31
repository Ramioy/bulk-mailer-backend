# 13. Interface: minimum information

The graphic design is defined in a later iteration. The interface must offer at least:

- **Selection** of period (current or previous) and block.
- **Batch summary** (§8.2), with the manifest version and the batch state.
- **Real-time progress** via SSE: sent versus manifest total, and counters by send state, delivery state and error type. While the batch pauses (§9.2.1): the reason, the wait and the time of the next send.
- **History per receipt:** attempts, recipient, copy, dates, `request_id`, `email_reference`, delivery events and last error.
- **Actions:** *Synchronise*, *Send*, *Resend* (§10.4), *Resolve uncertain* (§9.4) and *Release suppressed address* (§10.3). *Send* carries the manifest version on screen; a `409` shows the differences of §8.3 and disables *Send* until a new synchronisation.
- **Administration:** concept catalog and archive copy setting, both audited. Operator accounts are not administered from the interface (§15).
- **Alerts:** batch stopped, malicious file, hard bounces, complaints and webhooks not arriving (`WEBHOOKS_NO_RECIBIDOS`, §9.4). Alerts reach the interface through the `NotificadorAlertas` port (§14.2); the interface is the first registered provider.
