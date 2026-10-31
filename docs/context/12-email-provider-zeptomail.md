# 12. Email provider: Zoho ZeptoMail

## 12.1 Account and configuration

| Element | Value |
|---|---|
| Service | Zoho ZeptoMail (Zoho CPaaS). Only supports **transactional email**. In the account review, the service is described as *individual sending of payment receipts to each administration* |
| Sender domain | `anutibara.com`, managed in Zoho Mail. A Super Admin links the ZeptoMail account from the Zoho Mail console (*Transactional Emails*) |
| Domain authentication | SPF and DKIM verified; DMARC recommended. *Bounce address* verified on the domain |
| Agent | One dedicated to Bulk Mailer, with its own API key |
| IP restriction | Active, with the backend's outbound IP |
| Tracking | `track_opens` and `track_clicks` disabled |
| Automatic suppression | Enabled at the Agent level (§10.3) |
| Base URL | Configurable (`https://cpaas.zoho.com/v1.1` per the documentation) |
| Credits | Pay per use: 1 credit = 10,000 emails (USD 2.5) and they expire after 6 months. With about 300 emails per month (600 with copy), one credit covers its validity |

## 12.2 Credentials

| Use | Mechanism | Where |
|---|---|---|
| Sending | `Authorization: Zoho-enczapikey <Agent API key>` | Secrets manager |
| Logs API | OAuth 2.0 (`Zoho-oauthtoken`), scope `Zeptomail.email.READ` | Secrets manager |
| Suppressions API (release of addresses, §10.3) | OAuth 2.0 (`Zoho-oauthtoken`); the write scope is confirmed with the real account (§12.7) | Secrets manager |
| Webhooks | Agent *Authentication Key* (HMAC) + custom `Authorization` header | Secrets manager |

## 12.3 Message

`POST /v1.1/email`:

| Field | Value |
|---|---|
| `from` | Service account on `anutibara.com` |
| `to` | Resolved email of the contract (one only) |
| `bcc` | Copy address, only if the setting is active (§10.5) |
| `subject` | `<concept subject> – <Month> <Year>`, e.g. `Cuota extra – Octubre 2026`. **Does not include the contract.** The format is defined in code |
| `textbody` | **Plain-text** template defined in code (no HTML) |
| `attachments` | `[{ name: <file name>, mime_type: "application/pdf", content: <base64> }]` |
| `client_reference` | `intento_id` |
| `track_opens` / `track_clicks` | `false` |

The successful response is `200 {"data":[{"code":"EM_104",…}],"message":"OK","request_id":"…"}`. It does not include a per-recipient identifier; the `email_reference` is obtained with the logs API.

## 12.4 Classification of error codes

Errors arrive as HTTP 400, with a main `error_code` and a sub-code.

| Class | Sub-codes | Treatment |
|---|---|---|
| **Account or configuration** | `LE_101` credits expired · `LE_102` credits exhausted · `SERR_156` IP not allowed · `SERR_157` invalid API key · `SM_111` domain not verified · `SM_128` account not reviewed · `SM_133` trial limit · `SMI_115` daily limit · `AE_101` account blocked · HTTP 401 | `DETENIDO / PROVEEDOR_CUENTA` |
| **Receipt-level** | `SM_113` invalid address (`target_value` states the field) · `SM_120` mime type · `SM_127` / `SM_129` limits on attachment, name or fields | `FALLIDO / PROVEEDOR_RECHAZO` |
| **Our request** | `SM_101` invalid JSON · `GE_102` missing required field | `ERROR_INTERNO` |
| **Undocumented** | `429`, `5xx`, anything else | `INCIERTO` (§9.2) |

## 12.5 Webhooks

Active from the start. They are the main way to learn the delivery state.

| Aspect | Definition |
|---|---|
| Events | Delivered, soft bounce, hard bounce and spam complaint (*feedback loop*). Opens and clicks are not enabled |
| Endpoint | `POST /webhooks/zeptomail`, public over HTTPS and outside user authentication |
| Authenticity | 1) Custom `Authorization` header. 2) `producer-signature` signature (`ts`, `s`, `s-algorithm=HmacSHA256`), computed with the Agent's *Authentication Key* over the **decoded value of the single form-encoded parameter of the body**. Invalid signatures, algorithms other than HmacSHA256 and `ts` values more than 5 minutes away are rejected |
| Reception | The raw event is stored and `200` is answered immediately. Processing is asynchronous |
| Duplicates | Discarded by `webhook_request_id` |
| Correlation | `client_reference` (→ attempt) and `request_id`. Only the **primary recipient's** events count |
| Order | The delivery state only advances (§7.3) |

## 12.6 Provider console and logs

- **Processed Emails:** states `Queued`, `Processed`, `Delivered`, `Soft bounce`, `Hard bounce` and `Process failed`. Searchable by *Client Reference*, *Request Id*, recipient and other fields.
- **Content Preview:** optional. Keeps a copy of the email, downloadable as EML, for a limited time.
- Provider logs last **60 days** (extendable for a fee). **The permanent record is the Bulk Mailer database** (§15).

## 12.7 Undocumented behaviours and their control

| Unknown | Risk | Mitigation in the design | Validation with the real account |
|---|---|---|---|
| Delay with which an email appears in the logs API | A premature `EL_404` marks as not sent something that did go out → duplicate | Staggered queries (5, 15, 60 min). `NO_CONSTA_EN_PROVEEDOR` only after the last one. The webhook also resolves | Measure the delay over 20 test sends; the final margin must be ≥ 3 times the worst observed value |
| Response to a suppressed address (error or silent discard) | A receipt shows as `ENVIADO` and is never delivered | Local suppression list checked before sending. Reconciliation flags `ENVIADO` receipts without confirmation after N hours | Send to a suppressed test address |
| Rate limit (`429`) and `5xx` errors | Duplicates or blocked batches | Sequential sending with pause. Every undocumented response → `INCIERTO`. Growing wait and `DETENIDO` after 3 in a row | Check response headers; ask Zoho support about rate limits |
| Webhook retry policy | Lost or repeated events | Store and answer `200` immediately. Discard duplicates by `webhook_request_id`. Reconciliation covers lost events. Alert if the endpoint fails | Stop the endpoint during a test and observe whether ZeptoMail retries |
| Exact content of the *Delivered* event (cannot be simulated with *Send Test*) | Inability to process it | Tolerant parser based on `client_reference`, `request_id` and recipient. The raw event is stored | Real send and payload review |
| Account data centre | Wrong base URL | Configurable base URL | Confirm with the real account |
| `client_reference` filter of the logs API (exact or partial match) | Wrong correlation | The `intento_id` is a UUID; the returned value is also compared with the expected one | Test with similar references |
| Bounce of the copy mailbox | The copy gets suppressed | Its events go to an administration alert and do not affect the receipt | — |
| *Content Preview* retention time | — | Not relied upon: permanence is in our database and in the optional copy | Confirm in the account configuration |
| OAuth scope required to remove an address from the suppression list | Release (§10.3) cannot be completed | Release is atomic and fails closed if the API refuses | Confirm the scope with the real account and remove a test address through the API |
