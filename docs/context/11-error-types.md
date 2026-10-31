# 11. Error types

## 11.1 File errors (`INVALIDO` state or synchronisation incident)

| Type | Cause | Operator action |
|---|---|---|
| `NOMBRE_INVALIDO` | The name does not meet §4.2 | Rename and synchronise |
| `CONCEPTO_NO_CATALOGADO` | The concept is not in the catalog or is retired | Fix the concept or ask for it to be added to the catalog |
| `NOMBRE_DEMASIADO_LARGO` | More than 150 characters | Shorten the free part and synchronise |
| `ADJUNTO_DEMASIADO_GRANDE` | More than 15 MB | Reduce the PDF and synchronise |
| `ARCHIVO_NO_ES_PDF` | Invalid signature or structure | Regenerate the receipt |
| `PDF_CIFRADO` | The PDF asks for a password | Regenerate it without a password |
| `PDF_CONTENIDO_ACTIVO` | Contains JavaScript, automatic actions or embedded files | Regenerate it from the source system; notify IT if unexpected |
| `PDF_MODIFICADO` | Has incremental revisions above the threshold | Regenerate it from the source system |
| `ARCHIVO_MALICIOSO` | The antivirus detected it | **Do not open the file.** IT/Security receives an automatic alert |
| `DUPLICADO` | The same content is already registered | Remove the copy |
| `ARCHIVO_NO_ACCESIBLE` | Could not be read: locked, no permissions, deleted or empty | Close the file, check permissions and synchronise |

## 11.2 Recipient and send errors (no resolved recipient, or `FALLIDO`)

| Type | Cause | Operator action |
|---|---|---|
| `CONTRATO_NO_EXISTE` | The source does not know the contract | Check the file's `CNTRT` or the contract in the source |
| `CONTRATO_INACTIVO` | The contract is inactive or ended | Confirm with the business; remove the receipt if it does not apply |
| `CONTRATO_SIN_CORREO` | The contract has no valid email | Ask for it to be registered in the source |
| `CORREO_SUPRIMIDO` | The email bounced or complained before | Ask for the email to be corrected, or release it (§10.3) |
| `FUENTE_NO_DISPONIBLE` | The Tayrona or SAP API does not respond | Retry later or escalate to IT |
| `DESTINATARIO_CAMBIO` | The email changed between review and send | Synchronise, review and send |
| `ARCHIVO_MODIFICADO` | The hash changed between review and send | Synchronise, review and send |
| `PROVEEDOR_RECHAZO` | ZeptoMail rejected the message | Check the detail, fix and retry |
| `PROVEEDOR_NO_DISPONIBLE` | No connection with ZeptoMail | Retry later |
| `NO_CONSTA_EN_PROVEEDOR` | An `INCIERTO` that ZeptoMail confirms it did not receive | Retry |
| `ERROR_INTERNO` | Error in the request the system builds | Escalate to development |

## 11.3 Batch errors (`DETENIDO` state)

| Reason | Cause | Action |
|---|---|---|
| `PROVEEDOR_CUENTA` | Credits, API key, IP, domain, review or block of the ZeptoMail account | Escalate to the account administrator |
| `PROVEEDOR_NO_DISPONIBLE` | 3 consecutive connection failures, timeouts or `5xx` | Retry later |
| `FUENTE_NO_DISPONIBLE` | 3 consecutive failures of the source | Retry later or escalate to IT |
| `AGENTE_NO_DISPONIBLE` | The on-premise agent does not respond | Escalate to IT |
| `ERROR_INTERNO` | Programming error | Escalate to development |
| `INTERRUMPIDO` | The process restarted during execution | Wait for reconciliation and execute again |
