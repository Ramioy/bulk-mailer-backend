# 9. Idempotency and resolution of uncertain sends

## 9.1 Guarantees

| Guarantee | Mechanism |
|---|---|
| A content is not sent twice | SHA-256 hash + `ENVIADO` state + duplicate rules (§7.1) |
| What is sent is what was reviewed | Versioned manifest. Execution requires the version the operator saw (§8.3) |
| A file does not change between review and send | The hash is recomputed when sending |
| Every provider call is traceable | `intento_id` → `client_reference`. Recorded **before** calling |
| A lost response does not cause a duplicate | `INCIERTO` state + reconciliation |

## 9.2 Classification of the send response

| ZeptoMail response | Receipt state | Batch |
|---|---|---|
| `200` with `EM_104` | `ENVIADO` (the `request_id` is stored) | Continues |
| `400` with a receipt-level code (§12.4) | `FALLIDO / PROVEEDOR_RECHAZO` | Continues |
| `400` or `401` with an account or configuration code (§12.4) | `PENDIENTE` (the attempt is recorded as rejected) | `DETENIDO / PROVEEDOR_CUENTA` |
| `400` due to an error in our request (`SM_101`, `GE_102`) | `FALLIDO / ERROR_INTERNO` | `DETENIDO / ERROR_INTERNO` |
| Failure before sending the request (DNS, connection refused, TLS) | `FALLIDO / PROVEEDOR_NO_DISPONIBLE` | `DETENIDO` after 3 in a row |
| Timeout, `429`, `5xx`, undocumented response or process crash | `INCIERTO` | Pause with growing wait (§9.2.1). `DETENIDO / PROVEEDOR_NO_DISPONIBLE` after 3 in a row |

### 9.2.1 Growing wait

Applies to the last row of the table above. Only two waits are possible, because the third consecutive incident stops the batch.

| Consecutive incident | Wait |
|---|---|
| 1st | base |
| 2nd | base × 2 |
| 3rd | no wait: `DETENIDO / PROVEEDOR_NO_DISPONIBLE` |

- The base is configurable; default **30 seconds**.
- If the response carries `Retry-After` and it is longer than the computed wait, `Retry-After` is used.
- There is a configurable ceiling; default **10 minutes**. If `Retry-After` exceeds it, the batch stops immediately with `DETENIDO / PROVEEDOR_NO_DISPONIBLE` instead of waiting a time the operator is not watching.
- A successful send resets the counter.
- Every wait is reported to the interface as a progress event before it starts (§8.3) and recorded in the batch history.

## 9.3 Recovery after a crash

On restart, every receipt left in `ENVIANDO` becomes `INCIERTO` and the batch that was `EN_EJECUCION` becomes `DETENIDO / INTERRUMPIDO`. Reconciliation resolves the uncertain ones.

## 9.4 Reconciliation

A task queries the ZeptoMail logs API (`GET /v1.1/email?client_reference={intento_id}`) to:

- **Resolve the `INCIERTO` receipts.** Queried at 5, 15 and 60 minutes (configurable). A webhook with that `client_reference` also resolves it.
- **Sweep the `ENVIADO` receipts without events.** Those still `SIN_CONFIRMAR` after N hours (configurable) and up to 72 hours are queried, in case a webhook was lost.

| Result | State |
|---|---|
| Appears as `processed` or `delivered` | `ENVIADO` (`request_id` and `email_reference` are stored) |
| Appears as *Process failed* | `FALLIDO / PROVEEDOR_RECHAZO` |
| Hard or soft bounce (`is_hb`, `is_sb`) | Delivery state is updated |
| `EL_404` after the last query | `FALLIDO / NO_CONSTA_EN_PROVEEDOR`; can be retried |
| The logs API does not respond | Remains `INCIERTO` |

**Alert `WEBHOOKS_NO_RECIBIDOS`.** A silent webhook endpoint is indistinguishable from "no events yet", so the alert is inferred. Either condition raises it, at most once per execution:

1. **Proven loss.** The sweep finds in the ZeptoMail logs a delivery state for an `ENVIADO` receipt that received no webhook event.
2. **Total silence.** An execution ended with at least one `ENVIADO` receipt and, N hours later (the same N as the sweep), no webhook event has arrived for any of them.

The alert changes no state: reconciliation already corrects the receipts. It tells the operator to check the endpoint and the webhook configuration in ZeptoMail. It is delivered through `NotificadorAlertas` (§14.2).

If an `INCIERTO` is not resolved, the operator can resolve it by hand: they search the *Client Reference* in ZeptoMail's **Processed Emails** tab and mark it as **sent** or **not sent**, with an evidence note. The decision is audited.
