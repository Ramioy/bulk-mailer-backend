# Bulk Mailer — Registro de decisiones de arquitectura

Base: arquitectura acordada (hexagonal, monolito modular, una instancia, puertos y adaptadores, escala ~300 soportes/mes en 6 bloques).
Contexto analizado: `context-01.zip` (diseño funcional del 2026-10-30).

## Decisiones del 2026-10-31

| # | Tema | Decisión | Efecto en la arquitectura |
|---|---|---|---|
| D1 | Autenticación | JWT dentro del proceso, simple por ahora | Puerto `TokenVerifier` / `Autenticacion` con adaptador local. Sin proveedor de identidad externo |
| C1 | Entrada y custodia de PDFs | **Se mantiene lo acordado**: el cliente web sube los PDFs al Service y se guardan en el volumen `/data`. La custodia de los PDFs en el Service corre a cargo de TI | Puerto `FileStorage` con adaptador de volumen local. Se descarta "sin copias de PDF en la nube" del contexto |
| C2 | Reintentos | **Sin reintentos automáticos.** Cada repetición la decide el operador. Respuesta dudosa → `INCIERTO` + pausa creciente (30 s, ×2, detener a la 3.ª incidencia consecutiva) | `RetryPolicy` deja de ser puerto; la espera creciente es regla del núcleo |
| C3 | Motor de base de datos | **PostgreSQL 18** (reemplaza a SQLite) | Cambio de adaptador en persistencia, cola e idempotencia. Cola: tabla de trabajos + `FOR UPDATE SKIP LOCKED` |
| C4 | Idempotencia | Identidad por **SHA-256** del contenido + manifiesto versionado + `intento_id` (→ `client_reference`) registrado antes de llamar al proveedor | Restricciones UNIQUE sobre `sha256`, `intento_id`, `webhook_request_id` |
| C5 | Procesamiento | Por lote (periodo, bloque), **secuencial**, **una sola ejecución global** | Concurrencia = 1 + bloqueo global; la cola en PostgreSQL se mantiene |
| C6 | Progreso al cliente | **SSE**, según el contexto | Puerto `NotificadorProgreso` con adaptador SSE (reemplaza al polling) |
| C7 | Agente on-premise | **Descartado.** Carga manual desde el cliente web, sin acceso al Host / Active Directory | No hay segundo desplegable. Sin SMB ni VPN |

## Decisiones del 2026-10-31 (segunda ronda)

| # | Tema | Decisión | Efecto en la arquitectura |
|---|---|---|---|
| D2 | Sincronizar | **Se descarta.** El operador carga los archivos. Un archivo repetido (mismo SHA-256) no se cuenta | Caso de uso `UploadReceipts`. Desaparece el estado de lote "sin sincronizar" y la diferencia `RENAMED` |
| D3 | Validación de archivos | **Verificación sencilla** por ahora; proveedor robusto cuando el servicio crezca | Puerto `FileInspector` con adaptador `BasicPdfInspector`. A futuro: `QpdfClamAvInspector` |
| D4 | Archivos en el volumen | **Se descartan cuando el lote queda procesado** | Caso de uso `PurgeBatchFiles` al pasar el lote a `COMPLETED` |
| D5 | Idioma | **Todo en inglés**: puertos, adaptadores, estados, tipos de error, endpoints | Ver `arquitectura.md` §3 y §8 |
| D6 | Persistencia | Se agrega un puerto de persistencia y se conserva `Clock` | Puertos `BulkMailerRepository` y `Clock` |
| D7a | Fuente caída al enviar | El soporte queda `FAILED / SOURCE_UNAVAILABLE` ("no se pudo consultar la fuente") | Regla del núcleo |
| D7b | Rechazo por cuenta del proveedor | Transición `SENDING → PENDING` agregada al diagrama de estados | Regla del núcleo |
| D7c | Reenvío fallido | Vuelve a entrar al siguiente manifiesto normal | Regla del núcleo |

## Supuestos confirmados (2026-10-31)

A1 (regla de repetidos), A2 (purga y nueva carga para reintentar o reenviar), A3 (retirar soporte),
A4 (*Refresh recipients*) y A5 (periodo `YYYY-MM`, bloques en inglés) quedan **aprobados**. Detalle en `arquitectura.md` §9.

## Ajustes surgidos en el paso 1

| # | Ajuste | Motivo |
|---|---|---|
| P1 | El núcleo clasifica resultados de envío **neutrales** (`ACCEPTED`, `RECEIPT_REJECTED`, `ACCOUNT_ERROR`, `REQUEST_ERROR`, `CONNECTION_FAILED`, `UNCERTAIN`). La traducción de los códigos de ZeptoMail (`EM_104`, `LE_101`…) vive en `ZeptoMailEmailProvider` (paso 8) | Mantener al proveedor fuera del núcleo; cambiar de proveedor no toca el dominio |
| P2 | El `409` vuelve a reportar `RENAMED` y `RECIPIENT_CHANGED`, además de `ADDED` y `REMOVED` | Con *Refresh recipients* (A4) o una nueva carga del mismo hash con otro nombre, la versión cambia sin agregar ni quitar soportes; sin estos tipos, el sistema enviaría algo distinto de lo revisado |
| P3 | Transición `REMOVED → INVALID` (y `INVALID → INVALID`) en el diagrama de estados del soporte | Consecuencia de A1: volver a subir un hash retirado o inválido con un nombre que sigue siendo inválido |
| P4 | Fallas de conexión e incertidumbres comparten el contador de incidencias consecutivas; una respuesta definitiva del proveedor (aceptado o rechazado) lo reinicia | El contexto (§11.3) agrupa "fallas de conexión, timeouts o 5xx" en el mismo contador |
| P5 | ✅ **Aprobado.** Se permite `UNCONFIRMED → COMPLAINT`: una queja que llega sin evento de aceptación previo sí cambia el estado (y dispara la supresión) | Una queja implica que el correo llegó al buzón |
| D8 | ✅ **Aprobado.** Un archivo `REMOVED` de un lote puede subirse en otro lote o periodo: el mismo registro se mueve y se reevalúa, conservando su historial | Permite corregir un archivo puesto en el bloque equivocado |

P1 a P4: ✅ **aprobados** el 2026-10-31.

## Sesión y seguimiento del lote (2026-10-31)

| # | Decisión | Paso |
|---|---|---|
| D9 | ✅ El envío **no depende de la sesión**: lo procesa el proceso en segundo plano desde la cola | 6 |
| D10 | ✅ `GET /executions/current` devuelve, desde la base de datos, la ejecución en curso o la última: lote, versión del manifiesto, contadores, pausa (motivo y próximo envío), quién y cuándo. Visible para cualquier operador | 6 |
| D11 | ✅ Cada evento de progreso se guarda con número de secuencia; el SSE lo envía como `id` y al reconectarse se reanuda desde `Last-Event-ID` | 6 |
| D12 | ✅ El cliente web abre el SSE con `fetch` y `Authorization: Bearer` (el token nunca va en la URL). Al vencer el token, el servidor cierra el flujo; el cliente renueva y se reconecta | 4 (verificación con expiración) y 6 (flujo) |
| D13 | ✅ `POST /auth/sign-out` invalida la sesión. Las sesiones viven en `operator_sessions`; cerrar sesión invalida también el token de acceso vigente | 4 |

## Detalles de implementación del paso 4

- El token de renovación es de **un solo uso** (rotación en cada renovación); el token de acceso nunca dura más que la sesión.
- Contraseñas mínimas de **12 caracteres** en el comando `pnpm hash-password` (el contexto no fijaba un mínimo).
- Se agrega la acción de auditoría `SIGN_OUT`.
- JWT HS256 implementado con `node:crypto` (sin dependencia externa); clave `JWT_SIGNING_KEY` en base64 (≥ 32 bytes) desde el gestor de secretos.
- TLS terminado por el backend (`TLS_CERT_FILE`, `TLS_KEY_FILE`), obligatorio en producción.

## Detalles de implementación del paso 5

- Solo se guardan en el volumen los archivos que quedan `PENDING`. Un archivo `INVALID` no se guarda: corregirlo implica volver a subirlo.
- Un archivo de más de 15 MB se reporta como `REJECTED / ATTACHMENT_TOO_LARGE` y **no se registra** (sin hash no hay soporte). El servidor deja de leerlo al pasar el límite.
- Volver a subir un `FAILED` cuyo archivo fue purgado le devuelve el archivo y lo deja `FAILED` (entra al siguiente manifiesto). Si el nombre o el archivo nuevo no son válidos, se reporta `REJECTED` y el registro no cambia.
- Un soporte sin destinatario resuelto queda `PENDING` con el tipo de error del destinatario y fuera del manifiesto.
- Los comandos que cambian un lote (cargar, retirar, refrescar y, en el paso 6, iniciar una ejecución) se ejecutan **de a uno** dentro del proceso. Basta para la instancia única acordada y evita dos manifiestos con la misma versión.
- Fuera de producción, Tayrona y SAP son simulados (`FAKE_CONTRACTS_FILE`). En producción el servicio **no arranca** hasta tener los adaptadores reales (pasos 7 y 10).
- **Riesgo para el piloto:** con el umbral de revisiones incrementales en 0, un PDF *linealizado* (que trae dos `%%EOF`) se rechaza como `PDF_INCREMENTAL_UPDATE`. Se calibra con soportes reales (pendiente externo #9).

### Endpoints

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/batches/{YYYY-MM}/{BLOCK}/receipts` | Carga (multipart, partes `files`) |
| `GET` | `/batches/{YYYY-MM}/{BLOCK}` | Resumen para revisión (auditado como `BATCH_REVIEWED`) |
| `POST` | `/batches/{YYYY-MM}/{BLOCK}/refresh-recipients` | *Refresh recipients* |
| `DELETE` | `/receipts/{sha256}` | Retirar un soporte no enviado |

## Detalles de implementación del paso 6

- **Comprobaciones antes de llamar al proveedor:** archivo presente, mismo hash, mismo correo que el manifiesto y dirección no suprimida. Si alguna falla, el soporte queda `FAILED` con su tipo (`FILE_MODIFIED`, `RECIPIENT_CHANGED`, `EMAIL_SUPPRESSED`, `SOURCE_UNAVAILABLE`…) y el intento queda registrado sin llamada al proveedor.
- **Volver a enviar la misma versión tras una detención** procesa solo los soportes que siguen listos; un `SENT` nunca vuelve a entrar.
- **El `409` después de una ejecución** muestra como `REMOVED` los soportes que ya se enviaron (dejaron de estar listos), junto a los nuevos `ADDED`. Coincide con la definición de "excluido".
- **Contadores:** el total de una ejecución son los soportes listos al iniciarla.
- **Texto del correo:** ✅ aprobado el 2026-10-31 y **configurable** (ver abajo).
- **Si el proceso cae justo entre registrar la ejecución y encolarla,** la recuperación al reiniciar la detiene como `INTERRUPTED`.
  - *Nota (D40, 2026-10-31):* este caso ya no existe: el trabajo se encola en la misma transacción que registra la ejecución, así que hay ejecución con trabajo o no hay ninguna de las dos.
- **Alertas:** se guardan siempre y la interfaz las lee con `GET /alerts`; `UiAlertNotifier` es el único proveedor registrado.

### Endpoints

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/batches/{YYYY-MM}/{BLOCK}/executions` | *Send*, cuerpo `{ "manifestVersion": n }`. `202 { executionId }`; `409 MANIFEST_CHANGED` con `differences` |
| `GET` | `/executions/current` | Ejecución en curso o la última (D10) |
| `GET` | `/executions/{id}` | Estado de una ejecución |
| `GET` | `/executions/{id}/events` | SSE. Reanuda con `Last-Event-ID` (D11); se cierra con `FINISHED` o con `TOKEN_EXPIRED` (D12) |
| `GET` | `/alerts` | Alertas persistidas |

### Requisitos para el cliente web

- Abrir el SSE con `fetch` y `Authorization: Bearer` (D12), no con `EventSource`.
- Al recibir `TOKEN_EXPIRED` o perder la conexión: renovar el token y reconectar enviando `Last-Event-ID` con el último `id` recibido.
- Al iniciar sesión: consultar `GET /executions/current` y, si hay una en curso, abrir el SSE con `Last-Event-ID = lastEventSeq`.

## Plantilla del correo y bus de eventos (2026-10-31)

| # | Decisión |
|---|---|
| D14 | ✅ La plantilla es **configurable** con `EMAIL_TEMPLATE_FILE` (JSON `{ "subject", "body" }`) y marcadores `{{conceptSubject}}`, `{{periodLabel}}`, `{{complexName}}`, `{{fileName}}`. Por defecto, el texto aprobado. Un marcador desconocido, una parte vacía o un asunto con el nombre del archivo (lleva el contrato) impiden arrancar |
| D15 | ✅ **Bus de eventos con *outbox***: cada caso de uso escribe sus eventos de dominio en `outbox_events` dentro de la misma transacción que sus cambios. Un despachador los entrega después al `EventBus` (en proceso; Kafka a futuro), al menos una vez. Si un consumidor falla, el evento se vuelve a entregar en la siguiente pasada, hasta 10 intentos (es entrega interna, no un reenvío de correo) |
| D16 | Las **alertas** llegan a los proveedores registrados a través del bus (`ALERT_RAISED`): un proveedor que falla nunca bloquea la operación |

Eventos: `RECEIPTS_UPLOADED`, `RECEIPT_REMOVED`, `RECIPIENTS_REFRESHED`, `EXECUTION_STARTED`, `RECEIPT_SENT`, `RECEIPT_SEND_FAILED`, `RECEIPT_UNCERTAIN`, `EXECUTION_FINISHED`, `ALERT_RAISED`.

## Pasos 7 y 8: APIs externas simuladas (2026-10-31)

| # | Decisión |
|---|---|
| D17 | ✅ Los pasos 7 y 8 se construyen **contra simuladores** del contrato de cada API, mientras las APIs reales y la cuenta de ZeptoMail no estén disponibles. Los simuladores viven en `mocks/` y se usan en las pruebas y en desarrollo (`pnpm mock:contracts`, `pnpm mock:zeptomail`) |
| D18 | Tayrona y SAP usan **el mismo adaptador** (`HttpContractSource`) con distinta URL y token: exponen la misma interfaz (§6.1). El antiguo paso 10 queda cubierto |

### Supuestos por validar con las APIs reales

| Tema | Supuesto implementado | Validar con |
|---|---|---|
| Token de servicio de Tayrona/SAP | `Authorization: Bearer <token>` | Yoimar (construye las APIs) |
| Respuesta `200` de contratos | `{ contrato, activo, nombre_conjunto, correo }`; un cuerpo distinto o malformado es `SOURCE_UNAVAILABLE` | Yoimar |
| Formato del error `400` de ZeptoMail | La documentación solo muestra `{ "data": { "error_code", "message" }, "message": "error" }`; ZeptoMail suele responder `{ "error": { "code", "details": [{ "code", "target", "target_value" }] } }`. El adaptador entiende ambos y el simulador produce ambos | Cuenta real (§12.7) |
| `SM_113` | Si el campo inválido es `from`, `bounce_address` o `bcc`, es configuración → `ACCOUNT_ERROR` (detiene el lote). Si es el destinatario → `RECEIPT_REJECTED` | Cuenta real |
| Códigos no documentados en un `400` (p. ej. `TM_3004`) | `UNCERTAIN` (regla del contexto: lo no documentado es incierto) | Cuenta real |
| `429`, `5xx`, `Retry-After` | No documentados por Zoho; se tratan como `UNCERTAIN` con espera creciente | Soporte de Zoho (§12.7) |
| Fallas de conexión | DNS, conexión rechazada y TLS → `CONNECTION_FAILED` (certeza de no envío); conexión cortada después de enviar o timeout → `UNCERTAIN` | — |

### Configuración nueva

`CONTRACT_SOURCE` (`http`/`fake`), `TAYRONA_API_URL`, `SAP_API_URL`, `CONTRACT_API_TIMEOUT_MS` (5000); secretos `TAYRONA_API_TOKEN`, `SAP_API_TOKEN`.
`EMAIL_PROVIDER` (`zeptomail`/`fake`), `ZEPTOMAIL_BASE_URL` (`https://cpaas.zoho.com/v1.1`), `ZEPTOMAIL_FROM_ADDRESS`, `ZEPTOMAIL_FROM_NAME`, `ZEPTOMAIL_BOUNCE_ADDRESS`, `ZEPTOMAIL_TIMEOUT_MS` (30000); secreto `ZEPTOMAIL_API_KEY`.
`NONPROD_REDIRECT_TO`: buzón de prueba, **obligatorio** para usar ZeptoMail fuera de producción y **prohibido** en producción; el asunto muestra el destinatario original. En producción, los simulados están prohibidos.

## Paso 9: documentación de Zoho y simulador (2026-10-31)

Lectura de las páginas de `docs/context/19-references.md` (logs, autenticación, webhooks, supresiones, *Processed Emails*, códigos de error).

### Lo que sí está documentado

| Tema | Documentado |
|---|---|
| Lista de logs | `GET /v1.1/email` con filtros `client_reference`, `request_id`, `to`, `recipient`, `is_hb`, `is_sb`, `is_delivered`, `is_mailfailure`, `offset`, `limit`, `date_from`/`date_to`. Respuesta `{ data: [{ email_reference, sent_time, subject, from, to, request_id, mailagent_key, status }], status: "success" }`. **La lista no trae `client_reference`** |
| Detalle de un correo | `GET /v1.1/email/email-reference/{email_reference}`: el mismo objeto más `client_reference`, `opened_time`, `clicked_time` |
| No encontrado | `{ error: { code: "EL_404", message: "Email log not found" }, status: "failure" }`: **400** en la lista y **404** en el detalle |
| Credenciales de logs | OAuth 2.0, `Authorization: Zoho-oauthtoken <token>`, alcance `Zeptomail.email.READ` (o `.ALL`); el token de acceso dura 1 hora; sin token válido, `401` |
| Webhooks | `POST` con el evento JSON como **único parámetro de formulario**. `producer-signature: ts=<epoch ms>;s=<base64 codificado en URL>;s-algorithm=HmacSHA256`; HMAC-SHA256 con la *Authentication Key* del Agent sobre el **valor decodificado** del parámetro (`ts` no se firma). Encabezado de autorización propio opcional. `webhook_request_id` único por transacción. Objetos `softbounce`, `hardbounce`, `fbl_complaint` (con `fblFrom` = destinatario que se quejó) |
| Supresión automática | Quejas (*feedback loop*) y buzón, dominio o usuario inexistente |

### Supuestos (no documentados; implementados en el simulador y por validar con la cuenta real, §12.7)

| Tema | Supuesto |
|---|---|
| Un registro de log por destinatario | `to` y `bcc` tienen cada uno su `email_reference` |
| Valores de `status` del API | Solo `delivered` aparece documentado. Se suponen las etiquetas de la consola en minúscula: `queued`, `processed`, `delivered`, `soft bounce`, `hard bounce`, `process failed`. El adaptador normaliza (sin espacios, guiones ni mayúsculas) y un valor desconocido **no resuelve** nada |
| Coincidencia de `client_reference` | Desconocida (exacta o parcial): el adaptador confirma cada resultado con el detalle, que sí trae `client_reference`. El simulador tiene modo `partial` para probarlo |
| Retraso de aparición en los logs | Desconocido: el simulador lo simula con `logDelayMs` |
| JSON del webhook | No hay ejemplo completo publicado. Se produce el árbol documentado con `event_name`, `event_message`, `event_data` y `details` como arreglos; destinatario del rebote en `bounced_recipient` y de la entrega en `delivered_to`; objeto de entrega `email_delivered`. El adaptador debe tolerar arreglos u objetos y el evento crudo se guarda siempre |
| Formato del cuerpo | `Content-Type: application/x-www-form-urlencoded`, parámetro `data` (configurable); el adaptador toma lo que haya después del primer `=` |
| Clave HMAC | La *Authentication Key* como bytes UTF-8 |
| Política de reintentos de los webhooks | No documentada: ningún supuesto; la conciliación cubre los eventos perdidos |
| Servidor OAuth | No documentado en las páginas de CPaaS: `https://accounts.zoho.com/oauth/v2/token` con `grant_type=refresh_token` (configurable por centro de datos) |

### Hallazgo que choca con lo acordado

**No existe una API de supresiones documentada.** La página de autenticación nombra "Suppressions" entre las APIs con OAuth, pero no hay ruta, cuerpo, respuesta ni alcance; la supresión solo se gestiona desde la consola. §10.3 exige que la liberación se confirme con ZeptoMail antes de quitar la dirección de la lista local. Resuelto con **D19** (abajo).

### Simulador (`mocks/zeptomail-api.ts`)

- Logs (`GET /v1.1/email`, `GET /v1.1/email/email-reference/{ref}`) con token OAuth, `EL_404` documentado, retraso y coincidencia parcial configurables.
- Webhooks firmados hacia `MOCK_WEBHOOK_URL`, con el encabezado de autorización propio; `emit(clientReference, event)` en pruebas y `POST /__mock/events` en desarrollo.
- Escenarios de entrega en la parte local del destinatario: `softbounce`, `softhard`, `softdelivered`, `hardbounce`, `complaint`, `processfailed`, `nowebhook` (webhook perdido), `nolog`. El escenario `timeout` sí acepta el correo (respuesta perdida): aparece en los logs.

## Paso 9: entrega, conciliación, supresiones y reenvío (2026-10-31)

| # | Decisión |
|---|---|
| D19 | ✅ **Liberación confirmada desde la consola.** Como ZeptoMail no documenta una API de supresiones, el operador quita la dirección en la consola (*Suppression list*) y lo confirma en Bulk Mailer (`removedInProviderConsole: true`) junto con la validación del negocio y la nota de evidencia. Recién entonces sale de la lista local; todo queda auditado (`ADDRESS_RELEASED`, valor `CONFIRMED_BY_OPERATOR`). El puerto `SuppressionManager` no cambia; el adaptador es `ZeptoMailConsoleSuppressionManager`. Si Zoho confirma una API, se cambia el adaptador sin tocar el núcleo. Riesgo aceptado: si el operador se equivoca, el reenvío puede quedar `SENT` sin llegar; el barrido de `SENT` sin confirmar lo deja a la vista |

### Cómo quedó implementado

- **Webhook** `POST /webhooks/zeptomail` (sin sesión de operador; autenticado con las credenciales de ZeptoMail, D20): verifica el encabezado propio (`ZEPTOMAIL_WEBHOOK_AUTH_HEADER`, por defecto `authorization`), el algoritmo, `ts` (±`WEBHOOK_MAX_SKEW_SECONDS`, 300 s) y el HMAC; si algo falla responde `401` sin leer ni guardar el contenido. Si es válido guarda el evento crudo en `webhook_events` (único por `webhook_request_id`; sin id se usa el SHA-256 del cuerpo), responde `200` y deja el evento `WEBHOOK_RECEIVED` en el *outbox*; un consumidor encola `PROCESS_DELIVERY_EVENT`.
- **`ProcessDeliveryEvent`**: cada evento se guarda en `delivery_events` (duplicados por id) y solo cambia el soporte si es del **destinatario principal** del **último intento**. El estado de entrega solo avanza; un conflicto queda en el historial como `DELIVERY_ANOMALY`. Un rebote duro o una queja agregan la dirección a la lista local y generan alerta. Un rebote o queja de la copia genera `COPY_BOUNCED` y no toca el soporte. Un evento de un `UNCERTAIN` prueba el envío: pasa a `SENT`.
- **Conciliación**: el evento `RECEIPT_UNCERTAIN` (también el de la recuperación tras caída y el de un reenvío) programa `RECONCILE_ATTEMPT` a los 5, 15 y 60 min (`RECONCILE_DELAYS_MINUTES`). `NOT_FOUND_AT_PROVIDER` solo en la última; si la API de logs no responde, sigue `UNCERTAIN` (queda en el historial) y el operador puede resolverlo a mano. `Process failed` → `FAILED / PROVIDER_REJECTED`.
- **Barrido** cada `RECONCILE_SWEEP_INTERVAL_MINUTES` (60): `SENT` en `UNCONFIRMED` entre `RECONCILE_SWEEP_AFTER_HOURS` (N = 6, **supuesto**: el contexto no fija N) y `RECONCILE_SWEEP_MAX_HOURS` (72). Alerta `WEBHOOKS_NOT_RECEIVED` una vez por ejecución, por pérdida probada o por silencio total.
- ~~Los trabajos se procesan de a uno; durante una ejecución, la conciliación y los webhooks esperan a que termine.~~ Reemplazado por los dos carriles de D21.
- **`ZeptoMailSendLookup`**: lista por `client_reference`, toma solo la entrada del destinatario principal y la confirma con el detalle (`client_reference` exacto). Token OAuth con *refresh token* (`ZOHO_ACCOUNTS_URL`, por defecto `https://accounts.zoho.com`), en caché hasta 1 min antes de vencer; un `401` lo renueva una vez. Fuera de producción se consulta el buzón de prueba (`RedirectingSendLookup`).
- **Fuera de producción**, el buzón de prueba no identifica al destinatario de un webhook: sin copia el evento cuenta como del principal; con copia queda registrado sin cambiar el soporte.
- **Reenvío (A2)**: volver a subir el PDF de un `SENT` con `HARD_BOUNCE` o `COMPLAINT` y sin archivo, en el mismo lote, le devuelve el archivo sin cambiar su estado (decisión de carga `RESTORE_FILE`). `ResendReceipt` vuelve a consultar la fuente; la dirección suprimida (la misma que falló, salvo liberada, o una nueva también suprimida) se bloquea como `EMAIL_SUPPRESSED`. Un reenvío exitoso descarta el archivo; uno fallido queda `FAILED` y genera una versión de manifiesto nueva (D7c). El reenvío no exige que el periodo sea operable (los rebotes llegan días después), pero sí que no haya una ejecución en curso.
- **Resolución manual**: `ResolveUncertain` con `SENT` deja la entrega en `UNCONFIRMED`; con `NOT_SENT` deja `FAILED / NOT_FOUND_AT_PROVIDER`.
- ~~**Límite conocido**: si el barrido encuentra un `SENT` como `Process failed` en los logs (por ejemplo, una dirección suprimida descartada en silencio, §12.7), solo se anota en el historial (`PROVIDER_PROCESS_FAILED`): el diagrama no tiene transición `SENT → FAILED`.~~ Resuelto por D29.

Eventos nuevos: `WEBHOOK_RECEIVED`, `DELIVERY_UPDATED`, `RECEIPT_RESOLVED`, `ADDRESS_SUPPRESSED`, `ADDRESS_RELEASED`.

### Endpoints

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/webhooks/zeptomail` | Recepción de eventos de entrega: sin sesión de operador, con las credenciales de ZeptoMail (HMAC + encabezado propio); no devuelve datos (D20) |
| `POST` | `/receipts/{sha256}/resolve` | `{ "outcome": "SENT" \| "NOT_SENT", "note" }` |
| `POST` | `/receipts/{sha256}/resend` | Reenvío (§10.4) |
| `GET` | `/suppressions` | Lista local y modo de liberación (`OPERATOR` con D19) |
| `POST` | `/suppressions/{email}/release` | `{ "businessConfirmed": true, "removedInProviderConsole": true, "note" }` |

### Configuración nueva

`ZOHO_ACCOUNTS_URL`, `DELIVERY_CHECK_INTERVAL_SECONDS` (60), `DELIVERY_CHECK_TAIL_MINUTES` (30), `ZEPTOMAIL_WEBHOOK_AUTH_HEADER`, `WEBHOOK_MAX_SKEW_SECONDS`, `RECONCILE_DELAYS_MINUTES`, `RECONCILE_SWEEP_AFTER_HOURS`, `RECONCILE_SWEEP_MAX_HOURS`, `RECONCILE_SWEEP_INTERVAL_MINUTES`; secretos `ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET`, `ZOHO_OAUTH_REFRESH_TOKEN` (alcance `Zeptomail.email.READ`), `ZEPTOMAIL_WEBHOOK_KEY` (*Authentication Key* del Agent) y `ZEPTOMAIL_WEBHOOK_AUTHORIZATION` (valor del encabezado propio). Con `EMAIL_PROVIDER=zeptomail` son obligatorios.

### Por validar con la cuenta real (se suma a §12.7)

JSON real de cada evento (en especial *Delivered* y el campo del destinatario), nombre del parámetro del formulario, valores de `status` del API de logs, coincidencia de `client_reference`, servidor OAuth del centro de datos y esquema del encabezado (`Zoho-oauthtoken`), política de reintentos de los webhooks y existencia de una API de supresiones. Agregado por D35: **forma exacta del campo `to`** en `GET /v1.1/email` y en el detalle (texto, `Nombre <dirección>`, objeto o lista) y **paginación de `GET /v1.1/email`** (tamaño de página por defecto, parámetros `limit`/`offset` y si la respuesta indica que hay más páginas, y con qué campo). Agregado por D38: **límites de uso de la API de logs** (llamadas por minuto u hora) y **si comparten cuota con la API de envío**, para calibrar `DELIVERY_CHECK_BATCH_SIZE`. Agregado por D50: **límite de ZeptoMail sobre el mensaje codificado** (un adjunto de 15 MB son ~20 MB en base64), para calibrar `MAX_ATTACHMENT_BYTES`.

## Webhook, seguimiento por minuto y verificación manual (2026-10-31)

| # | Decisión |
|---|---|
| D20 | ✅ **El webhook no expone datos.** `POST /webhooks/zeptomail` solo recibe; no tiene sesión de operador porque ZeptoMail no puede iniciarla, y se autentica con las credenciales de ZeptoMail (encabezado secreto + HMAC + `ts`). **Toda consulta exige el JWT del operador**, incluida la nueva `GET /webhooks/zeptomail/events` (eventos recibidos y si se procesaron). Una prueba recorre todas las rutas y falla si alguna responde sin JWT fuera de la lista explícita (salud, inicio de sesión, renovación, cierre y la recepción del webhook) |
| D21 | ✅ **Seguimiento cada minuto mientras un lote se ejecuta y 30 minutos después** (`DELIVERY_CHECK_INTERVAL_SECONDS` = 60, `DELIVERY_CHECK_TAIL_MINUTES` = 30): se consultan en los logs los soportes de esa ejecución en `UNCONFIRMED`, `SOFT_BOUNCE` o `UNCERTAIN` hasta que llegan a un estado final. Un `UNCERTAIN` no encontrado no se marca fallido antes de la consulta de los 60 min. Para hacerlo posible, los trabajos en segundo plano tienen **dos carriles**: *ejecución* (un lote a la vez en todo el sistema, C5 sin cambios) y *entrega* (webhooks, conciliaciones, barridos y verificaciones, de a uno, en paralelo al lote). Un evento que llega mientras el soporte aún está `SENDING` se guarda y se aplica en cuanto se registra el resultado del envío. La alerta `WEBHOOKS_NOT_RECEIVED` se sigue evaluando a las N horas, para no dar falsas alarmas |
| D22 | ✅ **Verificación manual** con JWT y auditada (`DELIVERY_VERIFIED`): `POST /receipts/{sha256}/verify-delivery` y `POST /batches/{periodo}/{bloque}/verify-delivery` consultan ZeptoMail en el momento, aplican lo que encuentran y devuelven el resultado por soporte. Funcionan también durante un lote. Como la conciliación automática, nunca marcan fallido un `UNCERTAIN` (eso queda para la última consulta programada o la resolución manual con evidencia) |

### Cómo quedó implementado (D20 a D22)

- **Rutas sin JWT**, únicas y verificadas por `test/route-authentication.test.ts`: `GET /health`, `POST /auth/sign-in`, `POST /auth/refresh`, `POST /auth/sign-out` y la recepción `POST /webhooks/zeptomail`. Cualquier ruta nueva queda protegida o la prueba falla.
- **Dos carriles** (`JobLanes`): la cola filtra por tipo de trabajo (`claimNext(now, types)`). Carril de ejecución: `EXECUTE_BATCH`. Carril de entrega: `PROCESS_DELIVERY_EVENT`, `RECONCILE_ATTEMPT`, `SWEEP_UNCONFIRMED`, `CHECK_RECENT_SENDS`.
- **Sin pisarse**: todo cambio sobre soportes pasa por el mismo `SerialExecutor` de los comandos del lote, en tramos cortos (la consulta a ZeptoMail queda fuera). La ejecución en curso también escribe por él; solo el envío al proveedor y las pausas quedan fuera.
- **Eventos durante `SENDING`**: se guardan (`PENDING_SEND`) y se aplican al registrar el resultado del envío (también en el reenvío) o en la siguiente consulta.
- **Seguimiento por minuto**: un ciclo cada `DELIVERY_CHECK_INTERVAL_SECONDS` encola `CHECK_RECENT_SENDS` solo si hay una ejecución en curso o terminada hace menos de `DELIVERY_CHECK_TAIL_MINUTES`.
- **Alerta a las N horas** por ejecución: pérdida probada (algún soporte con estado conocido solo por los logs) o silencio total. Para un reenvío (sin ejecución), la pérdida probada se juzga en el barrido.
- **Verificación manual**: respuesta por soporte con `result` (`UPDATED`, `NO_CHANGE`, `NOT_FOUND`, `UNAVAILABLE`), el estado que muestra ZeptoMail y el estado resultante. Un soporte ya en estado final responde `409 RECEIPT_NOT_VERIFIABLE`.
- **Consulta de webhooks**: `GET /webhooks/zeptomail/events?limit=50` (máximo 500; sin el cuerpo crudo) y `GET /webhooks/zeptomail/events/{webhookRequestId}` (con el cuerpo).
- **Costo**: cada consulta son 2 llamadas a la API de logs por soporte pendiente; los límites de uso de Zoho no están documentados (§12.7).

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/webhooks/zeptomail/events` | Webhooks recibidos (JWT) |
| `GET` | `/webhooks/zeptomail/events/{webhookRequestId}` | Un webhook con su cuerpo crudo (JWT) |
| `POST` | `/receipts/{sha256}/verify-delivery` | Verificación manual de un soporte (D22) |
| `POST` | `/batches/{YYYY-MM}/{BLOCK}/verify-delivery` | Verificación manual de un lote (D22) |

## Paso 11: administración del catálogo y de la copia (2026-10-31)

| # | Decisión |
|---|---|
| D23 | ✅ **Catálogo de conceptos.** Se agregan conceptos; de uno existente se puede **cambiar el asunto**, **retirarlo** y **reactivarlo**. La **clave no se edita** (identifica el concepto en los nombres de archivo): para cambiarla se retira el concepto y se agrega otro. Un asunto nuevo aplica a los envíos y reenvíos posteriores; lo ya enviado no cambia |
| D24 | ✅ **Validación de una clave nueva**, con las reglas del nombre de archivo: NFC, palabras separadas por un solo espacio y sin espacios al borde, sin `CNCPT` ni `CNTRT`, y que el nombre más corto posible con ella quepa en 150 caracteres (máximo 130 caracteres). No puede repetir una clave existente, activa o retirada. El asunto no puede quedar vacío y se recortan sus bordes |
| D25 | ✅ **Retirar un concepto no toca lo ya cargado**: los soportes `PENDING` o `FAILED` con ese concepto quedan como están y se envían con el asunto vigente. El concepto retirado solo se rechaza en las cargas posteriores (`INVALID / UNKNOWN_CONCEPT`) |
| D26 | ✅ **Copia `bcc`.** Activarla sin `ARCHIVE_COPY_ADDRESS` configurada se rechaza con `ARCHIVE_COPY_NOT_CONFIGURED` (409); desactivarla siempre se permite. Se puede cambiar durante una ejecución: aplica desde la siguiente, porque `StartExecution` fija el valor al iniciar |

### Cómo quedó implementado

- Casos de uso `ManageConcepts` (agregar y modificar), `ListConcepts` y `ArchiveCopy`, por el mismo `SerialExecutor` que los comandos del lote. Cada cambio guarda, audita y deja su evento en `tx.outbox` en una sola transacción.
- **Auditoría**: `CONCEPT_CHANGED` con la clave como sujeto y `{ subject, active }` en JSON como valor anterior y nuevo (sin valor anterior al agregar). `ARCHIVE_COPY_CHANGED` con sujeto `archive-copy` y valores `true`/`false`. Una petición que no cambia nada (por ejemplo, retirar un concepto ya retirado) no se audita y responde el estado actual.
- **Eventos nuevos**: `CONCEPT_CHANGED` (`change`: `ADDED`, `RETIRED`, `REACTIVATED`, `SUBJECT_CHANGED`) y `ARCHIVE_COPY_CHANGED`.
- Las cuentas de operador no se administran desde la interfaz (§13).

### Supuestos (informados al usuario)

- **Campos JSON en inglés** (`key`, `subject`, `active`, `enabled`), como el resto de la API (D5), en lugar de `clave`, `asunto` y `activo` de la propuesta. Las claves del catálogo siguen en español (A5).
- La clave y el asunto **no pueden traer caracteres de control** (tabuladores, saltos de línea): el asunto va en el encabezado del correo.
- Las claves distinguen mayúsculas y minúsculas, igual que el nombre de archivo: `MULTA` y `Multa` serían dos conceptos distintos.

### Endpoints (todos con JWT, D20)

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/concepts` | Todos los conceptos, activos y retirados |
| `POST` | `/concepts` | `{ "key", "subject" }` → 201 con el concepto activo. Errores: `INVALID_CONCEPT_KEY` (422, con `reason`: `EMPTY`, `SPACING`, `RESERVED_WORD`, `TOO_LONG`, `CONTROL_CHARACTER`), `INVALID_CONCEPT_SUBJECT` (422), `CONCEPT_ALREADY_EXISTS` (409) |
| `PATCH` | `/concepts/{key}` | `{ "subject"?, "active"? }`. Errores: `CONCEPT_NOT_FOUND` (404), `NOTHING_TO_CHANGE` (400), `INVALID_CONCEPT_SUBJECT` (422) |
| `GET` | `/settings/archive-copy` | `{ "enabled", "address" }` (`address` es `null` si no está configurada) |
| `PUT` | `/settings/archive-copy` | `{ "enabled": bool }`. Error: `ARCHIVE_COPY_NOT_CONFIGURED` (409) |

## Correos en minúsculas (2026-10-31)

| # | Decisión |
|---|---|
| D27 | ✅ **Toda dirección de correo se normaliza a minúsculas, incluida la parte local**, y se le quitan los espacios de los bordes (`normaliseEmail`). Se aplica al correo que devuelven Tayrona y SAP, a la lista local de supresiones y su liberación, y a la comparación con el destinatario de los webhooks y de los logs de ZeptoMail. Así, `Admin@Altos.com` y `admin@altos.com` son la misma dirección para el manifiesto, la supresión y la detección de cambio de destinatario. Riesgo aceptado: el estándar permite que un servidor distinga mayúsculas en la parte local, pero en la práctica los proveedores no lo hacen. Surgió de la simulación de la rama `simulacion`, donde el simulador de ZeptoMail sí las distinguía |

## Ajustes aprendidos de la simulación (2026-10-31)

Propuestos tras el mes simulado de la rama `simulacion` (M1, M2, M3) y aprobados por el usuario.

| # | Decisión |
|---|---|
| D28 | ✅ **(M1) Un HTTP 400 con un código que no conocemos es un rechazo, no una incertidumbre.** Un 400 dice que ZeptoMail no aceptó la petición, así que el correo no salió. El soporte queda `FAILED / PROVIDER_REJECTED` en el acto, **sin pausa** y sin esperar a la conciliación (antes: `UNCERTAIN`, pausa de 30 s, cuenta para la detención y 60 min hasta `NOT_FOUND_AT_PROVIDER`). Se genera la alerta `PROVIDER_UNKNOWN_ERROR` con el código, para revisarlo y clasificarlo. Como un código desconocido puede ser un problema de la cuenta, **tres seguidos detienen el lote** (`STOPPED / PROVIDER_UNKNOWN_ERROR`); cualquier otra respuesta reinicia esa cuenta, y no se mezcla con la de incidentes inciertos. Cambia §12.4. Riesgo aceptado: si ZeptoMail respondiera 400 habiendo enviado el correo (no documentado, muy improbable), un reenvío lo duplicaría. Las demás respuestas no documentadas (200 sin `EM_104`, 429, 5xx, *timeout*, red) siguen siendo `UNCERTAIN` |
| D29 | ✅ **(M2) Un correo aceptado que ZeptoMail no procesa** (`Process failed` en los logs) pasa al **estado de entrega `PROCESS_FAILED`** (final; desde `UNCONFIRMED` o `SOFT_BOUNCE`), con la alerta `PROCESS_FAILED`, y **se puede reenviar** como tras un rebote duro o una queja (§10.4; el archivo se vuelve a subir, A2). La dirección **no** se suprime: no es culpa del destinatario. ZeptoMail no manda webhook para este caso, así que no cuenta como pérdida de webhooks ni para el silencio total de `WEBHOOKS_NOT_RECEIVED`. Un `UNCERTAIN` con `Process failed` sigue quedando `FAILED / PROVIDER_REJECTED`. Migración `ProcessFailed1761890400000` (amplía las restricciones de `receipts.delivery_state` y `delivery_events.state`) |
| D30 | ✅ **(M3) El simulador de ZeptoMail lee el escenario sin distinguir mayúsculas** (`+zm-sm_113` = `+zm-SM_113`) y responde los códigos en mayúsculas, como ZeptoMail. La app pasa los correos a minúsculas (D27), así que antes el simulador respondía un código inexistente |

### Por qué una respuesta incierta tarda hasta 60 min (sin cambios)

La conciliación busca un `UNCERTAIN` en los logs a los 5, 15 y 60 min (`RECONCILE_DELAYS_MINUTES`). Si lo encuentra, queda `SENT`; si no, solo se marca `FAILED / NOT_FOUND_AT_PROVIDER` en la última consulta, porque ZeptoMail no documenta cuánto tarda un correo en aparecer en sus logs (§12.7) y marcarlo antes invitaría a reenviar un correo que sí salió. Con D28 ese plazo ya no aplica a los 400. El valor se calibra con la cuenta real en el paso 12.

## Mismo contenido con nombres distintos (2026-10-31)

| # | Decisión |
|---|---|
| D31 | ✅ **Dos archivos con el mismo contenido (SHA-256) y nombres distintos se marcan ambos y no se envía ninguno hasta que el operador decida**, para que nada equivocado llegue a la bandeja de un cliente. Cambia D2 y A1: antes ganaba el primero en orden de carga y el segundo se descartaba como duplicado. Sigue habiendo **un solo registro por hash**. Reglas: (1) el mismo nombre es un duplicado normal; **cualquier otro nombre válido** es conflicto, aunque coincidan contrato y concepto. (2) El registro queda «por corregir» con `DUPLICATE_CONFLICT` y la lista de nombres (`conflicting_names`); no entra al manifiesto ni a ninguna ejecución y se publica una versión nueva del manifiesto de su lote. Actualizar destinatarios no lo desbloquea. (3) La carga responde `DUPLICATE_CONFLICT` con el nombre, contrato, concepto y lote del otro; el resultado del primero en la misma carga también lo muestra. (4) El operador elige un nombre con `POST /receipts/{sha256}/resolve-conflict` `{ "fileName", "note" }` (nota obligatoria, auditado `DUPLICATE_CONFLICT_RESOLVED`): toma ese nombre, contrato y concepto, se consulta su destinatario y queda listo; o lo retira con `DELETE /receipts/{sha256}`, lo que termina el conflicto y permite subirlo de nuevo con el nombre correcto. **(a)** Si el registro ya está `SENDING`, `SENT` o `UNCERTAIN` no se puede retener: la carga nueva responde `DUPLICATE_CONFLICT`, se anota en su historial y se genera la alerta `DUPLICATE_CONFLICT`; no se envía nada más. **(b)** Un nombre inválido no es un destino: sigue A1 (el registro toma el nombre válido, sin conflicto). **(c)** Con nombres en lotes distintos también hay conflicto: el registro queda bloqueado en su lote y, si el operador elige el nombre del otro lote, el soporte se mueve allí (como D8), con su archivo |

### Supuestos (informados al usuario)

- El nombre elegido se vuelve a validar al resolver: si su concepto se retiró entretanto, se rechaza con `CHOSEN_NAME_INVALID` (hay que retirar el soporte y subirlo con otro nombre).
- Un soporte `FAILED` en conflicto conserva su estado; al resolverlo vuelve a quedar listo para la próxima ejecución. Si su archivo se había purgado, la carga en conflicto lo guarda de nuevo.
- Migración `DuplicateConflicts1761894000000`: columna `receipts.conflicting_names` (`jsonb`).

## Robustez del carril de ejecución: auditoría, bloque 1 (2026-10-31)

Hallazgos A2 y M9 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`.

| # | Decisión |
|---|---|
| D32 | ✅ **(A2) Una excepción no prevista dentro de la ejecución no deja bloqueado el sistema.** `RunExecution` la atrapa: el soporte en curso pasa a `UNCERTAIN` si ya se llamó (o pudo llamarse) al proveedor, o a `PENDING` si con certeza no se llamó, con una entrada de historial con la causa; la ejecución y el lote terminan `STOPPED / INTERNAL_ERROR` con la alerta `BATCH_STOPPED`, el evento `FINISHED` y `EXECUTION_FINISHED` en el *outbox*, igual que cualquier otra detención. El trabajo se sigue marcando fallido (la excepción se relanza para que quede en el registro). Si detener también falla (p. ej. la BD caída), ambos errores se propagan y lo cubre la salida de emergencia o la recuperación al reiniciar. **Salida de emergencia del operador:** `POST /executions/{executionId}/abort` (JWT, auditado `EXECUTION_ABORTED`, nota obligatoria) hace con una ejecución lo mismo que la recuperación al arrancar: sus soportes `SENDING` pasan a `UNCERTAIN` y la ejecución termina `STOPPED / INTERRUPTED`. Para no abortar una ejecución sana, se rechaza mientras el último evento de progreso tenga menos de `EXECUTION_ABORT_AFTER_MINUTES` (10 por defecto), salvo `{ "force": true }`, que queda anotado en la auditoría |
| D33 | ✅ **(M9) Apagado cooperativo.** Al recibir `SIGTERM`, la ejecución en curso termina el soporte que está enviando (registra su resultado), no empieza ninguna pausa ni espera creciente y detiene el lote como `STOPPED / INTERRUPTED` **limpiamente**: sin soportes `SENDING` ni `UNCERTAIN` por culpa del apagado, con alerta, evento `FINISHED` y evento en el *outbox*. Cada carril de trabajos deja de tomar trabajos y espera el que está en curso como máximo `SHUTDOWN_TIMEOUT_SECONDS` (25 por defecto); pasado ese tiempo el proceso sigue apagándose y lo que quede `SENDING` lo resuelve la recuperación al reiniciar, como antes. Los carriles se detienen antes que el servidor HTTP y la base de datos, y después los ciclos periódicos |

### Cómo quedó implementado

- **`RunExecution`** (`src/application/sending/run-execution.ts`): el bucle va dentro de un `try/catch`; un registro del soporte en curso (`InFlight`) dice si ya se registró el intento y si ya se iba a llamar al proveedor (se marca **justo antes** de llamar, por prudencia). La liberación del soporte relee su estado dentro de la transacción: solo actúa si sigue `SENDING` y el intento existe. Luego se reutiliza `finish()`, todo por el `SerialExecutor` y con los eventos en `tx.outbox`. El intento queda con `finishedAt` y el detalle; si se había llamado al proveedor, con `outcome: UNCERTAIN` (como un *timeout*), y el evento `RECEIPT_UNCERTAIN` lleva `attemptId` y `executionId`, así que la conciliación se programa sola.
- **`finish()`** comprueba dentro de su transacción que la ejecución no haya terminado ya (abortada por el operador o terminada por un intento anterior que falló después del *commit*); en ese caso no toca nada. El evento `FINISHED` se emite antes de purgar los archivos, para que una falla del volumen no lo impida.
- **Ejecución que seguía viva tras un aborto:** al marcar el siguiente soporte `SENDING` comprueba en la misma transacción que la ejecución no haya terminado; si terminó, se retira sin tocar nada más. Antes de llamar al proveedor comprueba que su soporte siga `SENDING` (si el aborto ya lo liberó, no lo envía). Si la respuesta del proveedor llega después del aborto, un resultado cierto (`SENT`, o `FAILED` sin envío) asienta el `UNCERTAIN` (transiciones que ya existen); cualquier otro solo se guarda en el intento y en el historial (`OUTCOME_NOT_APPLIED`). Así un aborto de una ejecución sana no puede producir un doble envío.
- **`AbortExecution`** (`src/application/sending/abort-execution.ts`) y **`RecoverAfterCrash`** comparten `markSendingUncertain` y `stopExecution` (`interrupt-execution.ts`). El aborto solo libera los soportes `SENDING` cuyo último intento es de esa ejecución, todo en una transacción (soportes, ejecución, lote, *outbox*, alerta y auditoría); luego emite `FINISHED` con los contadores del último evento.
- **Actividad:** la hora del último evento de progreso; si es `WAITING`, cuenta hasta `nextSendAt` (una espera creciente de hasta 10 min se anuncia antes de empezar); si no hay eventos, la hora de inicio de la ejecución.
- **Auditoría** `EXECUTION_ABORTED`: sujeto = `executionId`; valor anterior `RUNNING <periodo>/<bloque>, last activity <instante>`; valor nuevo `STOPPED / INTERRUPTED, N receipt(s) UNCERTAIN`; nota del operador, con el prefijo `[forced]` si se forzó.
- **Señal de parada:** el *handler* de cada trabajo recibe un `AbortSignal` estándar (global de Node, sin Nest ni Fastify) y `RunExecution.execute(executionId, signal?)` lo recibe como parámetro. Se prefirió a un `shouldStop` en `ExecutionDependencies` porque la parada es de **esta** ejecución y de **este** trabajo, no una dependencia del caso de uso, y porque la misma señal interrumpe las esperas. El puerto `Clock` gana un parámetro opcional: `sleep(ms, signal?)` termina antes, sin error, si se aborta (`SystemClock`); `FixedClock` no cambia. No hace falta un puerto nuevo.
- **`JobRunner.stop()`** aborta la señal, deja de tomar trabajos (`drain` revisa la señal) y espera el trabajo en curso con tope (`stopTimeoutMs`); devuelve `false` y lo registra si no terminó a tiempo. El carril de entrega se detiene igual; sus trabajos son cortos e ignoran la señal.
- **`BackgroundWork`** detiene los carriles en `beforeApplicationShutdown` y no en `onApplicationShutdown`: Nest cierra el servidor HTTP entre esos dos ganchos, y con él la base de datos (gancho `onClose` de `bootstrap.ts`). Con el gancho anterior la ejecución en curso ya no podía registrar su último soporte. Una prueba verifica el orden.

### Endpoint (JWT, D20)

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/executions/{executionId}/abort` | `{ "note": "por qué", "force"?: true }` → 200 `{ executionId, result: "STOPPED", stopReason: "INTERRUPTED", uncertain: [sha256…] }`. Errores: `INVALID_REQUEST` (400, falta `note` o `force` no es booleano), `NOTE_REQUIRED` (400), `EXECUTION_NOT_FOUND` (404), `EXECUTION_NOT_RUNNING` (409, ya terminó; también el segundo POST de un doble clic), `EXECUTION_STILL_ACTIVE` (409, con `lastActivityAt` y `abortableAt`) |

### Configuración nueva

| Variable | Por defecto | Uso |
|---|---|---|
| `EXECUTION_ABORT_AFTER_MINUTES` | 10 | Minutos sin progreso a partir de los cuales el operador puede abortar sin forzar (D32). Entero positivo |
| `SHUTDOWN_TIMEOUT_SECONDS` | 25 | Segundos que cada carril espera su trabajo en curso al apagar (D33). Entero positivo |

### Supuestos (informados al usuario)

- **Se reutiliza `INTERRUPTED`** para el aborto del operador y para el apagado, en lugar de un motivo nuevo: para el operador y para el siguiente envío significan lo mismo (la ejecución se cortó desde fuera, no por un error del proveedor ni de la fuente), y la auditoría (`EXECUTION_ABORTED`) y el historial distinguen el caso. No se agregó ninguna transición: `SENDING → PENDING`, `SENDING → UNCERTAIN`, `UNCERTAIN → SENT/FAILED` y `RUNNING → STOPPED` ya existían.
- **"Ya se pudo llamar al proveedor"** se decide de forma conservadora: desde el instante anterior a la llamada. Una excepción en el registro del resultado deja el soporte `UNCERTAIN` aunque el proveedor haya respondido; la conciliación lo resuelve con los logs.
- **25 s de espera al apagar.** Cabe en el periodo de gracia por defecto de Kubernetes y ECS (30 s) con margen para cerrar HTTP y la BD. **Docker da solo 10 s por defecto**: hay que configurar `stop_grace_period: 40s` (o `docker stop -t 40`) en el despliegue del paso 12. Contrapartida aceptada: el envío a ZeptoMail tiene *timeout* de 30 s (`ZEPTOMAIL_TIMEOUT_MS`); un envío que tarde más de 25 s no se espera y su soporte queda `SENDING` hasta la recuperación al reiniciar, que lo pasa a `UNCERTAIN` (nunca se reenvía a ciegas, C2). Quien prefiera esperar siempre el envío completo puede fijar `SHUTDOWN_TIMEOUT_SECONDS=35` con una gracia de 45 s.
- **El soporte liberado por una excepción no genera evento `RECEIPT_PROCESSED`**: se cuenta en el `FINISHED`, para que nada más pueda fallar antes de cerrar la ejecución.
- **Sin prueba nueva contra PostgreSQL:** los cambios usan operaciones de almacén ya cubiertas por las pruebas de contrato (`tx.executions.get`, `tx.attempts.get`, `tx.receipts.get`); el aborto y la detención se prueban con el repositorio en memoria, que también revierte la transacción ante un error.

## Evidencia tardía y lectura de los logs: auditoría, bloque 2 (2026-10-31)

Hallazgos A1 y A4 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`. Los dos protegen la garantía principal: un contenido no se envía dos veces (§9.1).

| # | Decisión |
|---|---|
| D34 | ✅ **(A1) La prueba tardía de que un correo sí salió no se ignora.** Un evento de entrega (webhook o logs) del **último intento** de un soporte `FAILED / NOT_FOUND_AT_PROVIDER` (la última conciliación no lo encontró, o el operador lo resolvió como no enviado) lo pasa a `SENT`, con el estado de entrega que diga el evento según la máquina normal desde `UNCONFIRMED` (un rebote duro o una queja siguen suprimiendo la dirección y alertando), historial `SENT confirmed late by <delivery webhook|provider logs> (attempt …)`, evento `RECEIPT_RESOLVED` (`state: SENT`, `by`, `late: true`) y la alerta nueva **`LATE_SEND_EVIDENCE`**. Es la única transición `FAILED → SENT` y la aplicación comprueba la condición antes de hacerla (`awaitsLateEvidence`). Si la prueba es de un **intento anterior** que se creía no enviado y otro intento posterior tiene el soporte `SENDING`, `SENT` o `UNCERTAIN`, el estado no cambia pero se genera la alerta nueva **`DUPLICATE_SEND_DETECTED`** (el cliente probablemente recibió dos correos), una sola vez por intento. La verificación manual (D22) también consulta los soportes `FAILED / NOT_FOUND_AT_PROVIDER`; la conciliación automática no (sería un calendario nuevo) |
| D35 | ✅ **(A4) La consulta de logs solo responde "no encontrado" cuando ZeptoMail lo dice.** `NOT_FOUND` solo ante `EL_404` o una lista vacía (y cuando cada entrada del destinatario se confirma como **otro** envío). Una lista que no se puede leer (campo `to` ilegible o de otro destinatario, sin `email_reference`, detalle `404`, detalle sin `client_reference`) es `UNAVAILABLE` con el motivo, así que el soporte sigue `UNCERTAIN` y visible en lugar de fallar y reenviarse. El campo `to` se lee en todas las formas que usa ZeptoMail. Una lista que indica más páginas es `UNAVAILABLE` en lugar de adivinar |

### Cómo quedó implementado

- **Dominio** (`receipt-state.ts`): `FAILED` admite `SENT`, documentado como exclusivo de la evidencia tardía, y `awaitsLateEvidence(state, errorType)` (`FAILED` con `NOT_FOUND_AT_PROVIDER`) dice cuándo aplica. `alert.ts`: `LATE_SEND_EVIDENCE` y `DUPLICATE_SEND_DETECTED`.
- **`applyToReceipt`** (`apply-delivery-event.ts`): un soporte `UNCERTAIN` se confirma como antes; uno que `awaitsLateEvidence` se confirma tarde (`confirmLateSent`) y luego se aplica el estado de entrega del evento por el camino de siempre. Un evento `PROCESS_FAILED` no prueba que el correo saliera y no cambia nada. Todo dentro de la transacción y del `SerialExecutor` del que llama.
- **Logs** (`checkAttempt` en `reconciliation.ts`): con la opción `lateEvidence` (solo la verificación manual) también se consultan esos soportes; `QUEUED`/`PROCESSED` los confirma tarde igual que a un `UNCERTAIN`; `DELIVERED`, rebotes y `PROCESS_FAILED` pasan por `applyIncomingEvent`. Los eventos ya registrados del intento (antes ignorados) se aplican al consultar.
- **Doble aplicación**: la segunda prueba del mismo envío (el webhook y luego los logs, o al revés) encuentra el soporte ya `SENT` y sigue el camino normal: no hay segunda alerta. Los eventos repetidos se descartan por su id como antes.
- **Intento anterior**: se considera "creído no enviado" si su resultado no fue `ACCEPTED` y el intento **siguiente** es de un lote (`BATCH`), porque una ejecución solo toma soportes `PENDING` o `FAILED`; tras un envío que sí salió solo puede seguir un *Resend* (`RESEND`, desde `SENT`). Así no se alerta por el intento original tras un rebote y reenvío, aunque ese intento hubiera sido `UNCERTAIN` y confirmado después. La alerta se genera una vez por intento anterior (se busca entre las alertas existentes).
- **La ejecución en curso no reenvía** un soporte que la evidencia tardía dejó `SENT` después de que la ejecución empezó: al marcarlo `SENDING` lo relee dentro de la transacción y, si ya no está `PENDING` ni `FAILED`, lo salta (historial `SKIPPED`). Sin esto lo habría enviado otra vez, porque `SENT → SENDING` es una transición válida (*Resend*).
- **`ZeptoMailSendLookup`**: la función pura `logRecipients` (`log-recipients.ts`) lee `to` como `"dirección"`, `"Nombre <dirección>"`, `{ email_address: { address } }`, `{ address }`, `{ email }` o una lista de ellos, normalizado (D27). Las entradas de otro destinatario (la copia) se ignoran; si ninguna es del destinatario, es `UNAVAILABLE`. El detalle `logs API: N entries for the reference, none usable: <motivos>` lista los motivos. La confirmación exacta por `client_reference` con la llamada de detalle se mantiene.
- **Pruebas**: `test/application/late-evidence.test.ts` (incluye el escenario H1 de la auditoría como prueba real) y `test/adapters/zeptomail-send-lookup.test.ts` (cada forma de `to` y cada caso, con `fetch` inyectado). El simulador no cambió.

### Alertas nuevas

| Alerta | Sujeto | Detalle |
|---|---|---|
| `LATE_SEND_EVIDENCE` | SHA-256 del soporte | Archivo, intento y destinatario, cuándo se marcó `FAILED / NOT_FOUND_AT_PROVIDER`, qué llegó y de dónde (webhook o logs). Si entretanto se volvió a enviar, el cliente lo recibió dos veces |
| `DUPLICATE_SEND_DETECTED` | SHA-256 del soporte | El intento anterior y su dirección (que sí salió, qué llegó y de dónde) y el intento posterior, su dirección y el estado del soporte |

### Supuestos (informados al usuario)

- **"Prueba de envío"** es cualquier evento de entrega salvo `PROCESS_FAILED` (D29: ZeptoMail no lo procesó, el correo no llegó). Un `FAILED / NOT_FOUND_AT_PROVIDER` que los logs muestran como *process failed* sigue `FAILED` y listo para la siguiente ejecución.
- **Otros `FAILED` no cambian**: `PROVIDER_REJECTED`, `RECIPIENT_CHANGED`, `FILE_MODIFIED`, etc. son certezas de no envío; un evento sobre ellos se sigue anotando como `DELIVERY_EVENT_IGNORED`.
- **No se reprograma la conciliación automática** de los `FAILED / NOT_FOUND_AT_PROVIDER`: solo los webhooks que lleguen y la verificación manual pueden corregirlos. Si el paso 12 mide que la demora de los logs supera los 60 min, convendría una consulta más tardía (calendario nuevo, por aprobar).
- **"Ninguna entrada es del destinatario"** se trata como `UNAVAILABLE` aunque podría ser solo otro envío con una referencia parecida, porque también puede ser el nuestro con un `to` que no se supo leer.
- **Entradas confirmadas como otro envío**: si todas las entradas del destinatario resultan, por la llamada de detalle, ser de otro `client_reference` (coincidencia parcial, §12.7), la respuesta sigue siendo `NOT_FOUND`: no es una forma inesperada sino una negativa comprobada.
- **Paginación**: `has_more`/`hasMore` verdadero, `total`/`total_count`/`count` mayor que la página, o `next_offset`/`next`/`next_page` presentes, arriba o dentro de `info`/`page_info`, se toman como "hay más páginas". La API no lo documenta.
- **Orden de los intentos**: el "intento anterior" y el "siguiente" salen de `listByReceipt` (orden por `started_at` y luego `attempt_id`). Dos intentos del mismo soporte con el mismo milisegundo de inicio no ocurren en la operación (median minutos), pero en PostgreSQL el desempate por un UUID aleatorio no reflejaría el orden real.


## Dos fases y versión optimista: auditoría, bloque 3 (2026-10-31)

Hallazgos A3 y M11 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`. Para el operador nada cambia, salvo que los webhooks, la conciliación y la ejecución en curso ya no esperan a una carga o un reenvío lentos.

| # | Decisión |
|---|---|
| D36 | ✅ **(A3) Ninguna llamada externa con el `SerialExecutor` tomado (hace cumplir D21).** Cada comando tiene dos fases. **(a) Fuera del ejecutor:** las consultas a Tayrona/SAP (una por contrato), el `FileInspector`, el hash, la lectura de archivos y la llamada al proveedor. **(b) Dentro del ejecutor, en una transacción corta:** se vuelve a leer todo aquello de lo que depende la decisión (ejecución en curso y periodo operable, el soporte existente de cada hash, los lotes, el catálogo para el nombre elegido y la lista de supresiones) y se aplican las reglas (`decideUpload`, A1, D8, D31) sobre ese estado antes de escribir. Si el estado cambió (otra carga registró el mismo contenido, empezó una ejecución, se suprimió la dirección), la decisión se toma sobre el estado nuevo: el resultado es el que habría dado el comando de haber llegado después (`DUPLICATE`, `EXECUTION_IN_PROGRESS`, `EMAIL_SUPPRESSED`, `RECEIPT_NOT_IN_CONFLICT`…), sin errores nuevos. El **reenvío** queda como la ejecución, en tres tramos: (1) dentro, todas las negativas otra vez, el intento y `SENDING`; (2) fuera, el envío, como máximo una vez; (3) dentro, el resultado. Una excepción entre tramos libera el soporte (como D32): `UNCERTAIN` si el proveedor pudo recibirlo; si no, vuelve a `SENT` con el estado de entrega y el destinatario que tenía |
| D37 | ✅ **(M11) Versión optimista y manifiestos sin sobrescritura.** `receipts` y `batches` tienen una columna `version` (empieza en 1). Guardar inserta una fila nueva tal cual o actualiza **solo si** la versión guardada es la que se leyó, y la incrementa; si no, `ConcurrentModificationError`. `saveManifest` solo inserta: una versión repetida es `DuplicateManifestVersionError`. Así "nunca dos manifiestos con la misma versión" y "nadie pisa lo que otro escribió" los garantiza la base de datos, no solo el ejecutor en memoria. Estos errores no se atrapan ni se reintentan: dentro de esta única instancia significan un error en nuestra propia serialización y deben verse |

### Cómo quedó implementado

- **Carga** (`UploadReceipts`): fase (a) hash, nombre, inspector y consulta del contrato de cada archivo; fase (b) `serial.run(() => repository.transaction(...))` con las negativas sobre `tx`, el soporte existente leído en `tx`, la supresión (`withSuppression`) y todas las reglas de antes. La respuesta no cambió. Los archivos se guardan dentro de la fase (b), justo antes de la fila que los referencia: el volumen es local (no un servicio externo) y está direccionado por contenido, así que un archivo escrito para una transacción que no se confirma queda huérfano, inofensivo: la siguiente carga del mismo contenido lo sobrescribe y la purga del lote lo borra.
- **Actualizar destinatarios** (`RefreshRecipients`): las consultas en (a); en (b) se releen los soportes del lote y se aplica la supresión. Un soporte que apareció entre las fases (una carga intermedia) no se toca: esa carga acaba de resolver su destinatario.
- **Resolver conflicto** (`ResolveDuplicateConflict`): las comprobaciones y la consulta en (a); en (b) las mismas comprobaciones otra vez sobre `tx` (incluido el nombre elegido con el catálogo vigente), la supresión, la copia del archivo si cambia de lote y los manifiestos de **ambos** lotes, cuyos registros se leen dentro de la transacción.
- **Reenvío** (`ResendReceipt`): en (a) la lectura y el hash del archivo y la consulta a la fuente; tramo (1) dentro: ejecución en curso, `canResend`, archivo disponible, mismo contrato, supresión de la dirección (así se respeta un rebote duro procesado mientras se consultaba la fuente), copia `bcc`, intento y `SENDING`. Tramo (2) fuera: plantilla y envío. Tramo (3) dentro: resultado sobre el soporte releído, `applyPendingEvents`, manifiesto si quedó `FAILED`/`PENDING` (D7c), auditoría y *outbox*. Si falla antes de llamar al proveedor, el intento queda cerrado con el detalle y el soporte vuelve a `SENT` (transición `SENDING → SENT`, que ya existía) con su `deliveryState` y su destinatario anteriores, así que puede reenviarse otra vez. Esto cierra el problema adyacente señalado en el bloque 1.
- **Supresión fuera de la consulta**: `resolveRecipientFor`/`cachedResolver` se separaron en `lookupRecipient`/`cachedLookup` (fase a) y `withSuppression` (fase b). `refuseBatchCommand(deps, period, stores)` acepta los almacenes de la transacción.
- **Prueba de guarda** (`test/support/serial-guard.ts`): envuelve el `SerialExecutor` y los *fakes* de los puertos externos (fuentes de contratos, proveedor, logs e inspector) y registra cualquier llamada hecha con el ejecutor ocupado. Cubre carga, conflicto, resolución, actualización, ejecución, conciliación, verificación, webhooks y reenvío. Otra prueba comprueba que una fuente lenta durante una carga ya no retrasa un webhook.
- **Versión** (D37): `Receipt.version` y `Batch.version` en el dominio; `save` devuelve la entidad guardada con su versión nueva. PostgreSQL: `UPDATE … WHERE version = $n` y, si no hay fila, `INSERT … ON CONFLICT DO NOTHING`; sin ninguna de las dos, el error. En memoria, la misma regla. Migración `OptimisticVersions1761897600000` (columnas con valor por defecto 1). Pruebas de contrato para ambos adaptadores y una prueba en PostgreSQL con dos transacciones intercaladas: la segunda espera el bloqueo de fila y falla.
- **Cada escritor guarda lo que leyó en la misma transacción**: `RunExecution` construye el resultado del envío a partir del soporte releído en su tramo (antes usaba el leído antes del envío); `confirmSent` y `confirmLateSent` devuelven el soporte guardado; `RecoverAfterCrash`, `StartExecution`, `RemoveReceipt` y `ResolveUncertain` leen dentro de su transacción; una carga con el mismo contenido dos veces guarda una sola vez su última decisión. Dentro de `RunExecution`, un `ConcurrentModificationError` sigue el camino de D32 (detención limpia como `INTERNAL_ERROR`).
- **Convención**: `src/application/README.md` describe las dos fases y la regla de versión.

### Supuestos (informados al usuario)

- **Sin error nuevo `STATE_CHANGED`**: el estado nuevo siempre tiene una respuesta propia del comando (la que daría si hubiera llegado después), así que no hizo falta.
- **El catálogo de conceptos de una carga** se lee en la fase (a): un concepto retirado durante esos milisegundos se rechaza desde la carga siguiente (coherente con D25). La resolución de conflicto sí relee el catálogo en la fase (b).
- **El volumen local no cuenta como llamada externa** (D21 se refiere a servicios de red); por eso la escritura de archivos queda en la fase (b), antes de la fila que los referencia. Si en el futuro el almacén pasa a S3/Blob (§2), esa escritura debería pasar a la fase (a), con la misma regla de huérfanos.
- **Una fila nueva se inserta con la versión que trae** (1 en todo el código); un objeto "nuevo" para una clave que ya existe falla como uno desactualizado.
- **`ConcurrentModificationError` y `DuplicateManifestVersionError` no tienen código HTTP propio**: si ocurrieran responderían 500 y quedarían en el registro, porque indican un error del servicio, no del operador.

## Carriles, *outbox* y encolado: auditoría, bloque 4 (2026-10-31)

Hallazgos A5, M7 y M15 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`. Ningún reintento de estos envía correos (C2): solo reintentan trabajo interno.

| # | Decisión |
|---|---|
| D38 | ✅ **(A5) El trabajo de entrega no se acumula ni hace esperar a los webhooks.** (1) La verificación por minuto (`CHECK_RECENT_SENDS`) y el barrido (`SWEEP_UNCONFIRMED`) **no se encolan si ya hay uno esperando o en curso** (`JobQueue.hasPending`). (2) **Los webhooks van primero** porque tienen su propio carril: el carril de entrega de D21 se divide en dos, *webhooks* (`PROCESS_DELIVERY_EVENT`) y *consultas* (`RECONCILE_ATTEMPT`, `SWEEP_UNCONFIRMED`, `CHECK_RECENT_SENDS`). Se eligió esto y no una columna de prioridad porque no cambia el esquema y porque una prioridad no evita que un webhook espere a un trabajo de consultas ya en curso (con la API lenta, una verificación de 20 envíos puede tardar minutos); con un carril propio no espera nunca a una consulta. Todo cambio de soportes de cualquier carril sigue pasando por el mismo `SerialExecutor`. (3) **Presupuesto:** cada verificación por minuto consulta como máximo `DELIVERY_CHECK_BATCH_SIZE` envíos (20), los consultados hace más tiempo primero, y un envío cuya consulta encontró la API de logs no disponible se salta durante `DELIVERY_CHECK_BACKOFF_CYCLES` verificaciones (2). El barrido solo cambia en que no se duplica |
| D39 | ✅ **(M7) Un evento envenenado no bloquea el *outbox*.** Al décimo fallo de entrega el evento queda **muerto** (`dead_at`): sale de la ventana de pendientes, así que los que vienen detrás se entregan, y se genera la alerta **`OUTBOX_EVENT_DEAD`** en la misma transacción del relé. Un evento `ALERT_RAISED` muerto no genera otra alerta (solo se registra en el log), para que una alerta no pueda producir una cadena de alertas; la alerta en sí ya quedó guardada. El operador consulta los eventos muertos y puede pedir que se reintenten (auditado `OUTBOX_EVENT_RETRIED`) |
| D40 | ✅ **(M15) Un trabajo se encola en la misma transacción que lo origina.** Los almacenes de una transacción tienen `tx.jobs.enqueue`, sobre la misma tabla de la que el `JobQueue` toma los trabajos: el trabajo existe si y solo si la transacción se confirma. `StartExecution` encola `EXECUTE_BATCH` junto con el registro de la ejecución, el lote `RUNNING`, la auditoría y el evento. Los seguimientos (`RECEIPT_UNCERTAIN`, `WEBHOOK_RECEIVED`) siguen siendo consumidores del *outbox* y encolan por el `JobQueue`: el bus de eventos no lleva la transacción (ni debe: sus consumidores podrían estar en otro proceso, Kafka); no se pierde ningún trabajo porque un consumidor que falla hace que el relé reentregue el evento (y D39 alerta si muere), y un trabajo encolado dos veces es inofensivo |

### Cómo quedó implementado

- **D38, deduplicación:** `JobQueue.hasPending(type)` (`READY` o `CLAIMED`) en PostgreSQL y en memoria, con prueba de contrato. `requestRecentCheck` y `requestSweep` devuelven si encolaron.
- **D38, carriles:** `app.module.ts` arma tres `JobRunner` (ejecución, webhooks, consultas); los tres se detienen como en D33.
- **D38, presupuesto:** `CheckRecentSends` filtra sin llamar a nadie los envíos que siguen pendientes de entrega (último intento del soporte), los ordena por el ciclo en que se consultaron por última vez (nunca consultados primero; entre iguales, en orden de envío) y consulta los primeros `DELIVERY_CHECK_BATCH_SIZE`. Ese orden y el salto tras `UNAVAILABLE` se guardan en memoria en el caso de uso, no en la base: la verificación solo corre durante un lote y 30 min después, y un reinicio solo la devuelve a "el más antiguo primero", que también es justo. Así no hace falta escribir en la base en cada consulta.
- **D39:** columna `outbox_events.dead_at` (migración `OutboxDeadEvents1761901200000`, que además da por muertos los eventos que ya tenían 10 intentos y rehace el índice de pendientes); `markFailed(id, error, deadAt)`, `listDead`, `revive` en PostgreSQL y en memoria, con prueba de contrato (60 muertos y 1 vivo: se toma el vivo). Casos de uso `ListDeadEvents` y `RetryDeadEvent` en `src/application/events/`; controlador `OutboxController` sin acceso directo al repositorio.
- **D40:** `JobStore` en `BulkMailerStores`; en PostgreSQL usa la conexión de la transacción (`insertJob`, compartida con `PostgresJobQueue`); en memoria, el repositorio tiene una `InMemoryJobTable` que forma parte de su copia de transacción y que el `InMemoryJobQueue` de las pruebas comparte. Prueba de contrato en ambos: un trabajo encolado en una transacción que falla no existe. `ExecutionDependencies` ya no necesita la cola.

### Endpoints (JWT, D20)

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/outbox/dead?limit=50` | Eventos muertos, el más reciente primero (máximo 500): id, tipo, fecha, contenido, intentos, último error y cuándo murió |
| `POST` | `/outbox/dead/{eventId}/retry` | `{ "note"?: "…" }` → 200 `{ eventId }`: vuelve a pendiente con los intentos en cero. Auditado `OUTBOX_EVENT_RETRIED`. Error: `OUTBOX_EVENT_NOT_DEAD` (404) |

### Configuración nueva

| Variable | Por defecto | Uso |
|---|---|---|
| `DELIVERY_CHECK_BATCH_SIZE` | 20 | Envíos consultados como máximo en cada verificación por minuto (D38). Entero positivo |
| `DELIVERY_CHECK_BACKOFF_CYCLES` | 2 | Verificaciones que se salta un envío cuya consulta encontró la API de logs no disponible (D38). Entero ≥ 0 |

### Supuestos (informados al usuario)

- **Rotación en memoria** (D38), como se explica arriba. Con 300 soportes y 20 por minuto, cada envío pendiente se consulta al menos una vez cada 15 minutos durante el lote; los webhooks siguen siendo la vía principal.
- **La conciliación programada no tiene presupuesto:** `RECONCILE_ATTEMPT` sigue su calendario (5, 15 y 60 min por envío incierto) en el carril de consultas, sin presupuesto, porque son pocos y cada uno decide un estado.
- **Un trabajo encolado dos veces por un seguimiento** (D40) cuesta como mucho una consulta de logs más para un soporte que sigue `UNCERTAIN`; una conciliación de un soporte ya resuelto termina sin consultar y un webhook ya procesado se salta.
- **En memoria, un trabajo encolado dentro de una transacción es visible antes del *commit*** para el mismo proceso (no hay aislamiento); en PostgreSQL no lo es. Las pruebas no dependen de eso.
- **Un evento `ALERT_RAISED` muerto** solo deja constancia en el log del relé y en `GET /outbox/dead`; la alerta está en `GET /alerts`.

## Archivos de los soportes: auditoría, bloque 5 (2026-10-31)

Hallazgos M1 y M12 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`. Los PDF tienen datos personales (Ley 1581, §15): se guardan solo mientras algún soporte los necesita (D4).

| # | Decisión |
|---|---|
| D41 | ✅ **(M1) Ningún PDF se conserva indefinidamente.** (1) **Toda transición a `SENT`** (resultado del envío en la ejecución y en el reenvío, confirmación por webhook o por logs, evidencia tardía D34, resolución manual) deja el archivo no disponible y encola, **en la misma transacción** (D40), el trabajo `DELETE_RECEIPT_FILE`; el archivo se borra después del *commit* y nunca antes, para que un *rollback* no pierda un archivo todavía referenciado. (2) **Un lote `STOPPED` sin nada listo para enviar ni nada `SENDING`/`UNCERTAIN` pasa a `COMPLETED`** cuando se resuelve el soporte que lo deja así, con el evento `BATCH_COMPLETED` (`by: settlement`) y la purga de sus archivos. `STOPPED → COMPLETED` existe solo para este caso; un lote `OPEN` nunca se cierra solo. (3) Al completar una ejecución, la purga también es un trabajo (`PURGE_BATCH_FILES`) encolado en su transacción: desaparece la ventana de caída entre el *commit* y el borrado. (4) **Barrido de huérfanos** (`PURGE_ORPHAN_FILES`, cada `FILE_ORPHAN_SWEEP_INTERVAL_MINUTES`): borra los archivos que ningún soporte necesita y que tienen más de `FILE_ORPHAN_MIN_AGE_MINUTES`; si algún borrado falla, alerta `FILE_PURGE_FAILED` |
| D42 | ✅ **(M12) Completar un lote borra solo los archivos de los soportes que pasaron por un envío** (`SENT`, `FAILED` o `UNCERTAIN`) y que no están en conflicto. Un `PENDING` (con cualquier error, p. ej. `SOURCE_UNAVAILABLE` o `CONTRACT_NOT_FOUND`, que nunca entró al manifiesto) o un soporte en `DUPLICATE_CONFLICT` **conservan su archivo**: al corregir el destinatario o resolver el conflicto quedan listos sin volver a subirlo. El resumen del lote muestra el error propio del soporte en `errorType` y, aparte, `fileError: "FILE_NOT_AVAILABLE"` para cualquier `PENDING` o `FAILED` sin archivo (antes solo `FAILED`, y tapando su error). *Refresh recipients* informa cuántos soportes quedaron con destinatario pero sin archivo (`withoutFile`) |

### Cómo quedó implementado

- **Retiro del archivo** (`src/application/files/retire-file.ts`): `retireFile(tx, receipt, now)` encola `DELETE_RECEIPT_FILE { period, block, sha256 }` si el soporte tenía archivo; quien llama guarda `fileAvailable: false` en la misma transacción (`sentWithoutFile` para las confirmaciones). Lo usan `RunExecution` (resultado `SENT`), `ResendReceipt`, `confirmSent`, `confirmLateSent` y `ResolveUncertain`. Al volver un reenvío fallido a `SENT` (D36) el archivo **no** se retira: se había subido de nuevo para reenviar y se puede volver a intentar.
- **`DeleteReceiptFile`** (idempotente: un archivo que no está es un éxito) relee el soporte **dentro del `SerialExecutor`**, donde decide una carga: si el mismo contenido se volvió a subir entretanto para un *Resend* (A2) y está disponible en ese lugar, conserva el archivo. Se eligió esta comprobación y no llevar la versión (D37) en el trabajo porque lo que importa es si el archivo se necesita ahora, no si el soporte cambió por otra razón (por ejemplo, un evento de entrega).
- **`PurgeBatchFiles`** recibe la **lista explícita** de soportes cuyo archivo puede borrar (decidida en la transacción que completó el lote) y aplica la misma comprobación a cada uno. Se prefirió a "borrar los no disponibles del lote" porque una carga posterior al mismo lote no puede quedar dentro de una purga vieja.
- **Cierre por asentamiento** (`settleBatchIfDone` en `src/application/sending/batch-settlement.ts`): lo llaman `confirmSent`, `confirmLateSent`, el `fail` de la conciliación y `ResolveUncertain`, es decir, todo lo que resuelve un soporte de un lote detenido. Comprueba el estado del lote, que no quede ningún `SENDING`/`UNCERTAIN` y que el manifiesto vigente no tenga soportes listos; entonces `COMPLETED` (sin motivo de detención), purga con la regla de D42 y `BATCH_COMPLETED`. Un `FAILED` con archivo y destinatario sigue listo y el lote sigue `STOPPED` para que el operador lo envíe.
- **Carril de archivos**: un cuarto `JobRunner` (`DELETE_RECEIPT_FILE`, `PURGE_BATCH_FILES`, `PURGE_ORPHAN_FILES`). Borrar es E/S local y rápida; con su propio carril nunca espera a la API de logs. El volumen local no es un servicio externo (D36), así que el borrado ocurre dentro del ejecutor tras releer el soporte.
- **Barrido de huérfanos** (`PurgeOrphanFiles`): `ReceiptFileStore.list()` devuelve cada archivo con su fecha de modificación (volumen local con `stat`; en memoria, la hora del reloj al guardar; prueba de contrato); los `.tmp` de una escritura en curso no se listan. Se borra lo que tiene más de la edad mínima y cuyo soporte no existe, no lo necesita (`fileAvailable` falso) o vive en otro lote. La edad mínima evita competir con una carga, que escribe el archivo justo antes de su fila (D36). Se encola cada intervalo desde `BackgroundWork`, sin duplicarse (`hasPending`), y registra en el log cuántos borró.
- **Pruebas**: `test/application/receipt-files.test.ts` (cada camino a `SENT`, el escenario H4 de la auditoría como prueba real, un lote detenido que no se cierra, la evidencia tardía, un archivo vuelto a subir para *Resend* antes del borrado, el barrido y su alerta) y `test/application/processed-files.test.ts` (D42). Los *fixtures* ejecutan los trabajos de archivos al final de `startAndRun`, como el carril, y exponen `runFileJobs()`.

### Trabajos nuevos

| Trabajo | Carga | Lo encola |
|---|---|---|
| `DELETE_RECEIPT_FILE` | `{ period, block, sha256 }` | Toda transición a `SENT`, en su transacción |
| `PURGE_BATCH_FILES` | `{ period, block, sha256s }` | El cierre de un lote (`COMPLETED` por ejecución o por asentamiento), en su transacción |
| `PURGE_ORPHAN_FILES` | `{}` | `BackgroundWork`, cada `FILE_ORPHAN_SWEEP_INTERVAL_MINUTES`, si no hay uno pendiente |

### Cambios en las respuestas (cliente web)

| Endpoint | Cambio |
|---|---|
| `GET /batches/{YYYY-MM}/{BLOCK}` | Cada soporte puede traer `fileError: "FILE_NOT_AVAILABLE"` (`PENDING` o `FAILED` sin archivo). `errorType` siempre es el error propio del soporte: un `FAILED` sin archivo ya no muestra `FILE_NOT_AVAILABLE` en `errorType` |
| `POST /batches/{YYYY-MM}/{BLOCK}/refresh-recipients` | Agrega `withoutFile`: soportes que quedaron con destinatario pero sin archivo (hay que volver a subirlos) |

### Configuración nueva

| Variable | Por defecto | Uso |
|---|---|---|
| `FILE_ORPHAN_SWEEP_INTERVAL_MINUTES` | 360 | Cada cuánto corre el barrido de archivos huérfanos (D41). Entero positivo |
| `FILE_ORPHAN_MIN_AGE_MINUTES` | 60 | El barrido no toca archivos más recientes (D41). Entero positivo |

### Supuestos (informados al usuario)

- **`UNCERTAIN` cuenta como procesado** (D42) — ✅ aprobado por el usuario el 2026-10-31: al completar el lote su archivo se borra, como antes. Si después resulta no enviado (`FAILED / NOT_FOUND_AT_PROVIDER`), el operador debe volver a subirlo para reenviarlo; ese paso deliberado protege contra un duplicado si el correo sí salió (D34). Si se prefiere que entre solo al siguiente manifiesto, habría que conservarlo (por aprobar).
- **El método `purgeBatch` del puerto** queda sin uso en la aplicación; se conserva por compatibilidad y por su prueba de contrato.
- **El asentamiento no deja auditoría**: no es una acción de un operador; queda el evento `BATCH_COMPLETED` en el *outbox*.

## Alertas que dicen la verdad: auditoría, bloque 6 (2026-10-31)

Hallazgos M2, M3, M4, M6 y M14 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`.

| # | Decisión |
|---|---|
| D43 | ✅ **(M2) Un `UNCERTAIN` que la última consulta programada no resolvió no desaparece.** Si la consulta final lo deja `UNCERTAIN` (la API de logs no respondió, por ejemplo), se genera la alerta **`UNCERTAIN_UNRESOLVED`**, una vez por intento, con el archivo, el intento, el motivo y las salidas manuales (`verify-delivery` y `resolve`). El barrido horario también consulta los `UNCERTAIN` cuya última consulta programada ya pasó, hasta 72 h, **sin marcarlos nunca fallidos**: si aparecen en los logs quedan `SENT`; si no, siguen `UNCERTAIN`. Pasadas las 72 h solo se ven en el resumen del lote y en su alerta |
| D44 | ✅ **(M3, M4) El barrido cubre `SOFT_BOUNCE`, tiene presupuesto y no da falsas alarmas de silencio.** (1) El barrido consulta los `SENT` con entrega `UNCONFIRMED` **o `SOFT_BOUNCE`** entre N y 72 h: un rebote duro cuyo webhook se perdió se detecta, se suprime la dirección y se alerta. (2) **Presupuesto**: como máximo `RECONCILE_SWEEP_BATCH_SIZE` consultas por barrido (50), primero las que llevan más tiempo sin consultarse y luego las más antiguas, para que ninguna quede sin turno. (3) **Silencio total**: solo cuentan los envíos que salieron, es decir, cuyo soporte está `SENT` (o sigue `UNCERTAIN`) por ese intento; un envío incierto que resultó no existir (`FAILED / NOT_FOUND_AT_PROVIDER`) o que fue reemplazado por otro intento no espera webhook. Un envío confirmado tarde por los logs (D34) sigue siendo una pérdida probada de webhook, y la alerta lo dice |
| D45 | ✅ **(M6) Un webhook del que no se puede leer nada nuestro no pasa en silencio.** El lector del webhook informa qué nombres de evento vio y por qué descartó cada mensaje; eso se guarda con el webhook. Si un webhook autenticado no da ningún evento (salvo que solo traiga aperturas o clics) o todos sus eventos son de intentos desconocidos, se genera la alerta **`WEBHOOK_UNPARSED`**, una vez por webhook, con los motivos y dónde ver el contenido. La alerta de silencio distingue "no llegó ningún webhook" de "llegaron webhooks que no se pudieron leer" |
| D46 | ✅ **(M14) Alertas con las que el operador puede trabajar.** Las alertas se pueden **reconocer** (quién y cuándo; auditado `ALERT_ACKNOWLEDGED`, con nota opcional) y siguen en el historial. `GET /alerts` devuelve las **más recientes primero** (antes, las más antiguas), con filtros `pending`, `type`, `subject` y `limit` (200 por defecto, máximo 1000). La deduplicación de alertas consulta por tipo y sujeto en la base, sin leer todo el historial |

### Cómo quedó implementado

- **D43**: `ReconcileAttempt` genera la alerta cuando la consulta final deja el soporte `UNCERTAIN` (deduplicada por tipo, sujeto e intento). `SweepUnconfirmed` (se mantiene el nombre) suma los `UNCERTAIN` cuyo último intento terminó hace más que el último retraso de `RECONCILE_DELAYS_MINUTES` y menos de `RECONCILE_SWEEP_MAX_HOURS`; un envío que quedó `UNCERTAIN` por una caída no tiene hora de fin y cuenta desde su inicio. Siempre consulta con `final=false`.
- **D44**: el barrido usa `isPendingDelivery` (la misma regla que la verificación por minuto). El orden del presupuesto se guarda en memoria en el caso de uso, como en D38. El conteo de silencio relee cada soporte y comprueba que su último intento sea el del envío.
- **D45**: `parseZeptoMailWebhook` devuelve `notes` (`eventNames`, `dropped: [{ index, reason }]`, `onlyIgnorable`) además de los eventos. Se guardan en `webhook_events.parse_notes` (migración `WebhookParseNotes1761908400000`): es una columna `jsonb` y el operador los ve en `GET /webhooks/zeptomail/events/{id}` junto al cuerpo crudo, sin tener que reproducir el análisis. `ProcessDeliveryEvent` genera la alerta en la misma transacción en que marca el webhook procesado. De paso, el lector ahora entiende listas de textos (`event_name: ["hardbounce"]`), que antes descartaba, así que el nombre del evento sí sirve de respaldo.
- **D46**: columnas `alerts.acknowledged_at`/`acknowledged_by` e índices por tipo y sujeto y de pendientes (migración `AlertAcknowledgement1761904800000`). `AlertStore` gana `get`, `list(filtro)` filtrado en SQL (equivalente en memoria) y `acknowledge`; pruebas de contrato. Casos de uso `ListAlerts` y `AcknowledgeAlert`; `AlertsController` (el controlador de ejecuciones ya no lee el repositorio). `WEBHOOKS_NOT_RECEIVED`, `DUPLICATE_SEND_DETECTED`, `UNCERTAIN_UNRESOLVED` y `WEBHOOK_UNPARSED` se deduplican con la consulta filtrada.
- **Pruebas**: `test/application/pending-deliveries.test.ts` (H11, H8 y H9 de la auditoría como pruebas reales, presupuesto y rotación), pruebas HTTP de `WEBHOOK_UNPARSED` y de alertas, contratos de alertas, y la prueba del lector con los motivos de descarte.

### Alertas nuevas

| Alerta | Sujeto | Cuándo |
|---|---|---|
| `UNCERTAIN_UNRESOLVED` | SHA-256 del soporte | La última consulta programada dejó el envío `UNCERTAIN` (D43) |
| `WEBHOOK_UNPARSED` | `webhookRequestId` | Un webhook autenticado no dio ningún evento utilizable, o todos eran de intentos desconocidos (D45) |

### Endpoints (JWT, D20)

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/alerts?pending=true&type=&subject=&limit=` | Alertas, **las más recientes primero** (cambio de orden), 200 por defecto y 1000 como máximo. Errores: `INVALID_REQUEST` (400) por un filtro inválido |
| `POST` | `/alerts/{alertId}/acknowledge` | `{ "note"?: "…" }` → 200 con la alerta reconocida. Auditado `ALERT_ACKNOWLEDGED`. Errores: `ALERT_NOT_FOUND` (404), `ALERT_ALREADY_ACKNOWLEDGED` (409) |

### Configuración nueva

| Variable | Por defecto | Uso |
|---|---|---|
| `RECONCILE_SWEEP_BATCH_SIZE` | 50 | Consultas como máximo por barrido horario (D44). Entero positivo |

### Supuestos (informados al usuario)

- **Aperturas y clics** (`email_open`, `email_click`…) no son eventos de entrega: un webhook que solo trae eso no genera `WEBHOOK_UNPARSED`. Si ZeptoMail no se configura para enviarlos, nunca llegan.
- **Más allá de 72 h** un `UNCERTAIN` o un `SENT` sin confirmar ya no se consultan solos: quedan en el resumen y, el incierto, en su alerta.
- **Con 300 soportes y 50 consultas por hora** un barrido completo tarda unas 6 horas en el peor caso; los webhooks siguen siendo la vía principal y el barrido es la red de seguridad.
- **El cambio de orden de `GET /alerts`** (más recientes primero) es aceptable porque el cliente web todavía no existe.
- **Webhooks anteriores a D45** no tienen `parseNotes`: si no dieron eventos, la alerta dice "nothing readable".

## Despliegue seguro: auditoría, bloque 7 (2026-10-31)

Hallazgos M8, M10 y M13 de `docs/audit/auditoria-2026-10-31.md`, corregidos en la rama `audita`.

| # | Decisión |
|---|---|
| D47 | ✅ **(M8) Una segunda instancia nunca corrompe el lote en curso: C5 se hace cumplir.** Un *lease* en la base de datos (puerto nuevo `InstanceLease`) decide qué instancia es la **líder**: solo ella ejecuta la recuperación tras una caída, la liberación de trabajos abandonados, los cuatro carriles y los ciclos periódicos. Cualquier otra instancia atiende HTTP y queda **en espera**: lo anota en el log ("another instance holds the lease; this one serves HTTP only"), sigue pidiendo el *lease* y, si la líder muere, lo toma cuando expira y entonces sí ejecuta la recuperación. El *lease* dura `INSTANCE_LEASE_TTL_SECONDS` (30) y se renueva cada tercio. Una líder que no puede renovarlo deja de tomar trabajos en el acto (la ejecución en curso se detiene como `INTERRUPTED`, D33) y pasa a espera. Al apagarse, la líder detiene su trabajo y libera el *lease*. La estrategia de despliegue debe ser *recreate* (`deploy/README.md`) |
| D48 | ✅ **(M10) Las cargas no se guardan en memoria.** Cada archivo se escribe en un área de *staging* dentro del volumen (`/data/.staging/<uuid>`) mientras llega, calculando su SHA-256 por el camino. El caso de uso lee **un archivo a la vez** para el inspector y, en la fase (b), mueve el archivo a su lugar con un *rename* (atómico en el mismo volumen); lo que no se conserva (rechazado, inválido, duplicado) se descarta. Una petición que supera `UPLOAD_MAX_TOTAL_BYTES` (200 MB) o `UPLOAD_MAX_FILES` (300) recibe `413 UPLOAD_TOO_LARGE`, se descarta lo recibido y se cierra la conexión sin leer el resto. El límite de 15 MB por archivo no cambia (`REJECTED / ATTACHMENT_TOO_LARGE`) |
| D49 | ✅ **(M13) CORS para el cliente web.** `CORS_ALLOWED_ORIGINS` lista los orígenes exactos del cliente web; es **obligatorio en producción** y allí nunca `*`; fuera de producción, vacío significa CORS apagado. Se permiten los métodos de la API y los encabezados `Authorization`, `Content-Type` y `Last-Event-ID`; sin credenciales de navegador (el token va en el encabezado, no en *cookies*); la respuesta al *preflight* se guarda 10 minutos. Las peticiones sin `Origin` (el webhook de ZeptoMail, `curl`) no se ven afectadas |

### Cómo quedó implementado

- **D47, puerto `InstanceLease`** (`acquire`, `renew`, `release`, `current`): el adaptador PostgreSQL usa una tabla de una fila (`instance_lease`, migración `InstanceLease1761912000000`) y el reloj de la base: tomarlo es un `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now() OR holder = $yo`, atómico; renovar solo funciona si es propio y no expiró. Se prefirió a `pg_advisory_lock` porque un *advisory lock* pertenece a una conexión y el *pool* reparte conexiones; además, la fila sobrevive a una conexión caída hasta su expiración, que es lo que hace seguro el TTL. Adaptador en memoria para pruebas; pruebas de contrato en ambos, incluida la petición simultánea de cuatro instancias.
- **D47, `InstanceCoordinator`** (adaptador de entrada, sin Nest, en `src/adapters/inbound/jobs/`): espera → líder (recuperación una vez, luego carriles y ciclos); líder → espera si la renovación falla o lanza un error; líder → apagado (trabajo detenido, *lease* liberado). Para detener y reanudar bastan `stop` y `start` de `JobLanes` y `PollingLoop`, que ya podían reanudarse; no hizo falta `pause`/`resume`. `BackgroundWork` quedó como adaptador Nest delgado que renueva cada TTL/3. Si la recuperación falla, la instancia no arranca nada y libera el *lease*.
- **D47, invariantes**: a lo sumo una líder según el reloj de la base; una líder que no puede renovar deja de tomar trabajos al primer fallo, al menos dos tercios del TTL antes de que otra pueda tomarlo; la recuperación corre exactamente una vez por cambio de líder.
- **D47, `GET /instance`** (JWT): `{ instanceId, role, leaseHolder, leaseExpiresAt }`, por el caso de uso `GetInstanceStatus`, que lee el *lease* (no el estado interno del coordinador). `/health` sigue pública y mínima.
- **D48, puerto `ReceiptFileStore`**: `stage(trozos)` (escribe y calcula el *hash*; si el flujo falla, no deja nada), `readStaged`, `commitStaged` (*rename*), `discardStaged` y `listStaged`. Volumen local en `.staging` y versión en memoria; pruebas de contrato. El controlador pasa los trozos por `UploadReceipts.stage` (no toca el almacén directamente) y cuenta los bytes; el caso de uso recibe archivos ya preparados (los llamadores internos y las pruebas pueden pasar los bytes, que se preparan primero). El barrido de huérfanos (D41) también descarta lo preparado hace más de `FILE_ORPHAN_MIN_AGE_MINUTES` (una caída entre la recepción y la decisión).
- **D49**: `@fastify/cors` 11.3.1 (ya estaba en el árbol por Nest; ahora es dependencia directa) se registra en `bootstrap.ts` solo si hay orígenes configurados.
- **Pruebas**: dos coordinadores con un *lease* compartido y reloj fijo (espera, relevo con recuperación, la antigua líder que vuelve y se retira, base caída, apagado), dos aplicaciones con un mismo *lease* vistas por `GET /instance`; carga por HTTP con *staging* (sin escribir bytes desde memoria, una lectura a la vez), presupuesto total y de archivos (`413`), *staging* abandonado y barrido; *preflight* de un origen permitido y de otro, `Last-Event-ID`, webhook y `/health` intactos, y validación de la configuración.

### Puerto nuevo

| Puerto | Responsabilidad | Adaptador |
|---|---|---|
| `InstanceLease` | Qué instancia ejecuta el trabajo en segundo plano: tomar, renovar y liberar un *lease* juzgado por el reloj de la base (D47) | `PostgresInstanceLease` (tabla de una fila); en memoria para pruebas |

### Endpoints (JWT, D20)

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/instance` | `{ instanceId, role: "leader" \| "standby", leaseHolder?, leaseExpiresAt? }` (D47) |
| `POST` | `/batches/{YYYY-MM}/{BLOCK}/receipts` | Sin cambios en la respuesta; nuevo error `413 UPLOAD_TOO_LARGE` con `{ maxTotalBytes, maxFiles }` (D48) |

### Configuración nueva

| Variable | Por defecto | Uso |
|---|---|---|
| `INSTANCE_LEASE_TTL_SECONDS` | 30 | Duración del *lease*; se renueva cada tercio (D47). Entero ≥ 3 |
| `UPLOAD_MAX_TOTAL_BYTES` | 209715200 (200 MB) | Bytes de archivos por petición de carga (D48). Entero positivo |
| `UPLOAD_MAX_FILES` | 300 | Archivos por petición de carga; también el límite del *multipart* (D48). Entero positivo |
| `CORS_ALLOWED_ORIGINS` | (vacío) | Orígenes exactos del cliente web, separados por coma (`https://host[:puerto]`, sin ruta ni barra final). Obligatorio en producción, nunca `*` allí (D49) |

### Para el cliente web (D49)

- Puede estar en otro origen, siempre que ese origen esté en `CORS_ALLOWED_ORIGINS` exactamente como lo envía el navegador.
- Envía el token en `Authorization: Bearer …`; no usa *cookies* (`credentials: "omit"`, el valor por defecto de `fetch`).
- Puede enviar `Content-Type` (JSON o *multipart*) y `Last-Event-ID` (para reanudar el SSE, D11). Ningún otro encabezado propio.

### Supuestos (informados al usuario)

- **Superposición en el relevo** (D47): la líder que no puede renovar deja de tomar trabajos en el acto, pero un envío ya en curso puede tardar hasta 30 s (`ZEPTOMAIL_TIMEOUT_MS`) y la siguiente líder puede tomar el *lease* 20 s después del primer fallo. En ese caso la recuperación de la nueva líder deja ese soporte `UNCERTAIN` (conservador) y la ejecución vieja, al volver, se retira sin tomar otro soporte (guardas de D32 y versiones de D37); su resultado, si es cierto, asienta el soporte como en D32. Ningún correo se envía dos veces.
- **La instancia en espera atiende HTTP**: sus comandos usan su propio `SerialExecutor`; las versiones optimistas (D37) y el manifiesto de solo inserción impiden que dos instancias se pisen, pero el diseño sigue siendo de una instancia.
- **El identificador de instancia** es `host:pid:aleatorio`, para reconocerla en el log y en `GET /instance`.
- **Las pruebas y los llamadores internos** pueden seguir entregando bytes a `UploadReceipts`; solo la ruta HTTP, que es la que recibe cargas grandes, prepara los archivos sobre la marcha.
- **`*` fuera de producción** se admite para desarrollo local.

## Cierre de la auditoría: bajos y adyacentes (2026-10-31)

| # | Decisión |
|---|---|
| D50 | ✅ **Cierre de la auditoría: hallazgos bajos (§5) y problemas adyacentes encontrados en los bloques 1 a 7.** Uno por fila en la tabla siguiente. Quedan fuera, como preguntas al usuario, dos decisiones de negocio y B2 |

| Ítem | Qué se hizo |
|---|---|
| B1 | Tras un error de cuenta el soporte vuelve a `PENDING` **sin** el detalle del proveedor; la causa queda en el intento y en el historial |
| B3 | Retirar un soporte y resolver un conflicto (D31) son correcciones: se permiten en cualquier periodo; solo una ejecución en curso los rechaza |
| B4 | Casos de uso de consulta `ListSuppressions`, `ListWebhooks`, `GetWebhook` y `ExecutionEventsQuery`; `ProgressNotifier.subscribe`; los controladores reciben `Clock` y los secretos del webhook por su propio *token*. Reglas nuevas en `architecture.test.ts`: la entrada no importa la salida; los adaptadores solo importan de la composición sus *tokens* o tipos; ningún controlador lee el repositorio |
| B5 | Límite por IP en las rutas públicas de autenticación (`AUTH_RATE_LIMIT_PER_MINUTE`, 20; `429` con `Retry-After`), sin bloquear cuentas; el usuario intentado de `SIGN_IN_FAILED` se audita sin caracteres de control y con 100 caracteres como máximo |
| B6 | Fuera de producción, cada intento registra el buzón de prueba al que se redirigió (`redirectedTo`); un rebote de ese buzón alerta pero **no** suprime la dirección real |
| B7 | Registro de operación: una línea JSON por evento de dominio (carga, inicio y fin de ejecución, resultado de cada envío, resolución, webhook, cambio de entrega, supresión, alerta) y resúmenes de conciliación, barrido, verificación por minuto y procesamiento de webhooks; solo identificadores, estados y conteos |
| B8 | `GET /health` comprueba la base (`SELECT 1`) y el volumen; si algo falla responde `503 { status: "degraded", checks }`; sigue pública y mínima |
| B9 | `PURGE_FINISHED_WORK`, diario: borra los trabajos terminados y los eventos del *outbox* despachados con más de `WORK_RETENTION_DAYS` (30). Los eventos muertos y todo registro de negocio se conservan |
| B10 | `MAX_ATTACHMENT_BYTES` es configuración (15 MB por defecto, sin cambio de comportamiento); el límite de ZeptoMail sobre el mensaje codificado pasa a §12.7 |
| B11 | El barrido horario lee solo los soportes pendientes actualizados dentro de su ventana (`listPendingDeliveriesSince`), no todo el historial |
| B12 | `attempts.seq` desempata intentos con la misma hora de inicio (orden `started_at, seq`) |
| Bloque 2 | Evidencia de un intento **anterior** incierto cuando el último también quedó `FAILED / NOT_FOUND_AT_PROVIDER`: el soporte queda `SENT` por esa evidencia (regla de D34, alerta `LATE_SEND_EVIDENCE`); antes quedaba listo para un tercer envío |
| Bloques 3 y 5 | `RemoveReceipt` y `ResolveDuplicateConflict` encolan el borrado del archivo en su transacción (D41) en vez de borrar después del *commit*; el reenvío ya no tenía borrado directo |
| Bloque 6 | Las alertas guardan una referencia (el intento) y `AlertFilter` acepta `reference` y `since`: `UNCERTAIN_UNRESOLVED` y `DUPLICATE_SEND_DETECTED` se deduplican por ella, no por su texto |

### Cómo quedó implementado

- **Migraciones**: `Hygiene1761915600000` (`alerts.reference`, `attempts.seq`, índices de limpieza) y `AttemptRedirect1761919200000` (`attempts.redirected_to`).
- **Puertos que cambiaron**: `ProgressNotifier.subscribe`; `ReceiptStore.listPendingDeliveriesSince`; `AlertStore` con `reference` y `since`; `JobQueue.purgeFinished`; `OutboxStore.purgeDispatched`; `EmailProvider.redirectsTo` (opcional: lo declara `RedirectingEmailProvider`); puerto nuevo `ReadinessProbe` (adaptador `SystemReadinessProbe`). Todos con pruebas de contrato o unitarias.
- **B6, diseño**: en lugar de que cada `SendOutcome` traiga el destinatario efectivo, el proveedor declara una sola vez si redirige (`redirectsTo`) y los casos de uso lo anotan en el intento. Es lo mínimo que cuenta la verdad: la redirección es una propiedad del proveedor configurado, no de cada respuesta.
- **Evidencia de un intento anterior**: después de confirmar así el soporte, los eventos siguientes de ese mismo intento no se toman como duplicado (se reconoce por la alerta `LATE_SEND_EVIDENCE` con su referencia).
- **B7**: el consumidor está en `src/adapters/outbound/logging/operation-log.ts` y nunca falla (un problema del log no hace reentregar el evento). El `Logger` de Nest solo se usa en la composición.
- **B9**: el trabajo corre en el carril de archivos (limpieza local, rápida) y no se duplica (`hasPending`).
- **B5**: el limitador es un gancho de Fastify en memoria (no hay `@fastify/rate-limit` en el árbol), con ventana fija de un minuto por IP. Las aplicaciones de prueba suben el límite porque inician sesión muchas veces desde la misma dirección; la prueba del límite usa 3.
- **Pruebas**: `test/application/audit-closure.test.ts`, `test/application/housekeeping.test.ts`, `test/operability.test.ts`, las reglas nuevas de `test/architecture.test.ts` y los contratos ampliados.

### Configuración nueva

| Variable | Por defecto | Uso |
|---|---|---|
| `WORK_RETENTION_DAYS` | 30 | Días que se conservan los trabajos terminados y los eventos despachados (B9) |
| `MAX_ATTACHMENT_BYTES` | 15728640 (15 MB) | Archivo más grande aceptado (B10) |
| `AUTH_RATE_LIMIT_PER_MINUTE` | 20 | Peticiones por minuto e IP a las rutas públicas de autenticación (B5) |

### Trabajos nuevos

| Trabajo | Cuándo |
|---|---|
| `PURGE_FINISHED_WORK` | Una vez al día, en la instancia líder (D47), si no hay uno pendiente |

### Supuestos (informados al usuario)

- **Orden de los intentos**: se ordena primero por hora de inicio y luego por `seq`. No se usa solo `seq` para que los datos ya existentes, numerados al migrar en el orden físico de la tabla, no cambien de orden.
- **Soporte confirmado por un intento anterior**: su estado de entrega queda como lo dejó esa evidencia; los eventos siguientes de ese intento no lo cambian (solo cuentan los del último intento), y el barrido consulta el último intento, que no aparece en los logs. Es un caso marginal; el operador puede verificarlo a mano.
- **B3**: resolver un conflicto puede mover el soporte a un lote de un periodo cerrado; enviarlo sigue exigiendo un periodo operable.
- **`execution_events`** no se purga: es lo que permite repetir el progreso de una ejecución (D10, D11) y es pequeño.
- **El límite de autenticación** es por proceso y se reinicia con él.

### Preguntas al usuario (respondidas el 2026-10-31)

1. **Retención máxima de los PDF** de soportes que siguen "necesarios" (un `FAILED` que nunca se reenvía, un `PENDING` que nunca se corrige): hoy se conservan mientras sigan así (D41/D42). ¿Plazo máximo, por ejemplo al cerrar el periodo? → **Respondida en D51**: sin plazo; liberación manual por lote que conserva los registros.
2. **Reconocer solas las alertas** cuando su causa se resuelve (por ejemplo, un `UNCERTAIN_UNRESOLVED` que el barrido confirma después). Hoy el operador las reconoce (D46). → **Respondida en D52**: el sistema las marca resueltas; reconocerlas sigue siendo del operador.
3. **B2**: corregir el contrato de un soporte subiéndolo con el nombre arreglado produce un `DUPLICATE_CONFLICT` con nota obligatoria (consecuencia de D31). ¿Se acepta esa fricción o se permite reemplazar el nombre en la misma carga? → **Respondida en D53**: no se reemplaza; se retira el soporte y se sube con el nombre corregido.

## Respuestas del usuario a las preguntas de D50 (2026-10-31)

| # | Decisión |
|---|---|
| D51 | ✅ **(Pregunta 1 de D50) Retención de los PDF: indefinida, con liberación manual que conserva los registros.** No hay plazo máximo: los archivos de soportes que siguen "necesarios" (`FAILED` nunca reenviado, `PENDING` nunca corregido, conflictos) se conservan **hasta que el operador los libera**, un lote a la vez, con nota obligatoria. Liberar borra los archivos, no los registros: estados, errores y conflictos no cambian, el resumen muestra `fileError: FILE_NOT_AVAILABLE` y el archivo se puede volver a subir (A2). La estructura del volumen no cambia (`<DATA_DIR>/<YYYY-MM>/<BLOCK>/<sha256>.pdf`); el usuario eligió no copiar la del servidor de archivos (`OCTUBRE_2026/EFECTIVO`) y la equivalencia se documenta en `deploy/README.md`. **No hay liberación de un periodo entero**: un lote a la vez mantiene la auditoría precisa (cada registro dice qué lote y cuántos archivos) |
| D52 | ✅ **(Pregunta 2 de D50, opción 3) Alertas: resolución híbrida.** El sistema marca una alerta **resuelta** (`resolvedAt`, `resolution`) cuando su causa se resuelve, pero **reconocerla sigue siendo del operador** (D46): una alerta resuelta sigue pendiente hasta que alguien la reconoce. `GET /alerts` conserva su comportamiento por defecto (todas, las más recientes primero) y gana el filtro `resolved` |

### Cómo quedó implementado

- **D51**:
  - Caso de uso `ReleaseBatchFiles` (`src/application/files/release-batch-files.ts`), dentro del `SerialExecutor` y de una sola transacción, sin llamadas externas (fase b de D36).
  - Para un `(periodo, bloque)`, cada soporte con `fileAvailable=true` que **no** está `SENDING` queda con `fileAvailable=false`, una entrada `FILE_RELEASED by <operador>` en su historial y un trabajo `DELETE_RECEIPT_FILE` encolado en la transacción (D41): el archivo se borra después del *commit* por el carril de archivos.
  - Publica una nueva versión del manifiesto (las entradas listas salen de él), audita `BATCH_FILES_RELEASED` (sujeto `periodo/bloque`, valor nuevo: cuántos, nota obligatoria) y agrega al *outbox* el evento `BATCH_FILES_RELEASED` (que el registro de operación escribe, B7).
  - Es una corrección, como B3: se permite en cualquier periodo y solo la rechaza una ejecución en curso (`EXECUTION_IN_PROGRESS`, la misma regla global que los otros comandos de lote; un lote `RUNNING` implica una ejecución en curso).
  - **Volver a subir**: la regla de carga (A1) ahora reevalúa también un `PENDING` sin archivo del mismo lote, como ya hacía con un `FAILED` sin archivo. Recupera el archivo, conserva el estado y el conflicto si lo hay, y actualiza nombre y destinatario. Antes un `PENDING` sin archivo se tomaba como duplicado y no había forma de devolverle el archivo.
- **D52**:
  - `Alert` gana `resolvedAt?` y `resolution?` (motivo breve), y `AlertFilter` gana `resolved?: boolean` (`true`, solo resueltas; `false`, solo sin resolver; sin valor, todas).
  - `AlertStore.resolve(match, at, resolution)` resuelve todas las alertas coincidentes aún sin resolver, estén reconocidas o no, y devuelve cuántas. `match` es un tipo con `subject`, `reference` o ambos y, opcionalmente, `raisedNotAfter`. Tiene pruebas de contrato en PostgreSQL y en memoria.
  - Migración `AlertResolution1761922800000`: columnas, índice de alertas sin resolver por tipo y sujeto, y `reference` de las `BATCH_STOPPED` existentes tomada de su detalle (`<periodo>/<bloque> stopped: …`).
  - Ayudantes `resolveAlerts`, `resolveReceiptAlerts` y `resolveBatchStopped` (`src/application/alerts/resolve-alerts.ts`), siempre en la transacción del cambio que resuelve la causa.
  - `GET /alerts` acepta `resolved=true|false` junto a `pending`. **Para el cliente web**: la vista por defecto es "por atender" (`?pending=true&resolved=false`); una segunda pestaña, "resueltas, por revisar" (`?pending=true&resolved=true`); el historial completo, sin filtros.
- **Pruebas**:
  - `test/application/release-files.test.ts`.
  - `test/application/alert-resolution.test.ts`: un caso por tipo que se resuelve solo y uno que comprueba que los demás siguen sin resolver.
  - Prueba HTTP de `release-files` (incluida en la lista de rutas con JWT) y del filtro `resolved`.
  - Contrato de `resolve` y la regla de carga de un `PENDING` sin archivo.

### Endpoint (JWT, D20)

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/batches/{period}/{block}/release-files` | `{ "note": "…" }` → 200 `{ "released": n, "manifestVersion": v }`. Errores: `INVALID_REQUEST` (400, sin `note`), `NOTE_REQUIRED` (400, nota vacía), `BATCH_NOT_FOUND` (404), `EXECUTION_IN_PROGRESS` (409) |
| `GET` | `/alerts?pending=&resolved=&type=&subject=&limit=` | Como D46, más `resolved` (D52). Las alertas traen `resolvedAt` y `resolution` cuando el sistema las resolvió |

### Qué alertas se resuelven solas (D52)

| Alerta | Se resuelve cuando | Cómo se encuentra |
|---|---|---|
| `UNCERTAIN_UNRESOLVED` | El soporte sale de `UNCERTAIN`: confirmado por un evento o por los logs, fallido por la conciliación, resuelto por el operador, o con el resultado de un envío abortado (D32) | Sujeto (SHA-256) y referencia (el intento) |
| `BATCH_STOPPED` | Una ejecución posterior del mismo lote termina `COMPLETED`, o el lote detenido se asienta (D41) | Referencia `periodo/bloque` (nueva en estas alertas) |
| `HARD_BOUNCE`, `COMPLAINT`, `PROCESS_FAILED` | Un envío posterior del soporte sale (`SENT`): reenvío, lote siguiente o confirmación de un envío incierto | Sujeto (SHA-256), solo las generadas hasta el inicio de ese envío: un rebote del propio envío nuevo no se resuelve con él |
| `DUPLICATE_CONFLICT` | El conflicto se resuelve (`resolve-conflict`) o el soporte se retira | Sujeto (SHA-256) |
| `OUTBOX_EVENT_DEAD` | El evento revivido por el operador (D39) se entrega | Sujeto (id del evento) |
| `FILE_PURGE_FAILED` | Un barrido posterior termina sin fallas: borró todo lo que nadie necesita, incluidos los archivos que antes no pudo borrar | Sujeto (`receipt-files`) |

**No se resuelven nunca solas**, porque nada de lo que el sistema observa después prueba que su causa desapareció:

- `COPY_BOUNCED`: el buzón de copia hay que revisarlo.
- `WEBHOOKS_NOT_RECEIVED` y `WEBHOOK_UNPARSED`: hay que revisar la configuración del webhook o el formato.
- `LATE_SEND_EVIDENCE` y `DUPLICATE_SEND_DETECTED`: el cliente pudo recibir el correo dos veces y hay que hablar con él.
- `PROVIDER_UNKNOWN_ERROR`: hay que clasificar el código.
- `MALICIOUS_FILE`: hay que investigar el archivo.

### Supuestos (informados al usuario)

- **D51, `UNCERTAIN` sin archivo**: liberar alcanza también a los `UNCERTAIN` y a los `SENT` que guardan el archivo para un reenvío (A2), como pide la regla "todo lo que no está `SENDING`". Un `SENT` rebotado puede recuperar el archivo subiéndolo de nuevo. Un `UNCERTAIN` no puede recuperarlo hasta que se resuelve; si termina `FAILED`, entonces sí.
- **D51, lote reabierto**: como toda corrección que publica manifiesto, un lote `COMPLETED` o `STOPPED` vuelve a `OPEN` al liberar (`publishNextManifest`, igual que retirar un soporte).
- **D51**: liberar un lote sin archivos disponibles responde `released: 0` y publica igualmente una versión del manifiesto y su auditoría. Así cada pedido del operador queda registrado.
- **D52, `DUPLICATE_CONFLICT`**: hoy esa alerta solo se genera cuando el contenido ya se estaba enviando o ya se envió (D31, punto a). Esos soportes no se pueden retirar ni resolver mientras sigan así, de modo que en la práctica se resuelve sola solo si el envío termina `FAILED` y luego se retira; casi siempre la reconocerá el operador.
- **D52, `FILE_PURGE_FAILED`**: es una alerta por barrido (sujeto común `receipt-files`), así que se resuelve cuando un barrido completo termina sin fallas, no archivo por archivo. Si un barrido vuelve a fallar se genera otra.
- **D52**: resolver una alerta no genera un evento de dominio ni avisa al operador; el cliente web lo ve al consultar. Las `BATCH_STOPPED` anteriores a la migración reciben su referencia del detalle; las demás alertas anteriores sin referencia se resuelven por sujeto como las nuevas.

## B2 cerrado por decisión: sin reemplazo de nombre en la misma carga (2026-10-31)

| # | Decisión |
|---|---|
| D53 | ✅ **(B2, pregunta 3 de D50) No se reemplaza el nombre en la misma carga.** Si el operador sube con el nombre corregido un archivo que ya estaba registrado con un nombre equivocado, el sistema sigue tratándolo como `DUPLICATE_CONFLICT` (D31). Para corregirlo, el operador **retira el soporte con el nombre equivocado** (`DELETE /receipts/{sha256}`, que termina el conflicto) y **sube el archivo con el nombre corregido**. Decisión del usuario del 2026-10-31 |
| D54 | ✅ **Contadores de una ejecución recuperada.** `lastCounters` (recuperación tras caída y aborto, D32) toma el último evento de progreso **con contadores** (`STARTED`, `RECEIPT_PROCESSED`, `FINISHED`), no el último evento. Antes, si el proceso moría durante una pausa (`WAITING`), el `FINISHED` quedaba con `processed 0` y así lo mostraba `GET /executions/{id}` para siempre. Hallado por el tercer mes simulado (`sim/reports/2026-10-31-mes-simulado-3.md`). Aprobado por el usuario el 2026-10-31 |
| D55 | ✅ **`release-files` no reabre el lote.** Liberar los archivos (D51) publica una versión nueva del manifiesto, pero el lote conserva su estado (`COMPLETED` o `STOPPED`); solo un lote `OPEN` sigue `OPEN`. Antes `publishNextManifest` ponía `OPEN` siempre, y un lote terminado parecía por enviar. Las demás publicaciones (carga, retiro, conflicto resuelto, destinatarios) siguen reabriendo, porque sí cambian lo que hay por enviar. Hallado por el tercer mes simulado. Aprobado por el usuario el 2026-10-31 |

### Cómo quedó implementado

- **Sin cambios de código.** Los dos pasos ya existen: retirar un soporte termina su conflicto (D31) y libera su contenido, y volver a subirlo con el nombre correcto lo registra de nuevo en ese lote (o lo mueve, D8). Retirar es una corrección: se permite en cualquier periodo y solo lo rechaza una ejecución en curso (D50, B3).
- **Para el cliente web**: cuando una carga devuelve `DUPLICATE_CONFLICT`, ofrecer las dos salidas: elegir el nombre correcto (`POST /receipts/{sha256}/resolve-conflict`, con nota) o retirar el soporte y subirlo de nuevo.

