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
- **Límite conocido**: si el barrido encuentra un `SENT` como `Process failed` en los logs (por ejemplo, una dirección suprimida descartada en silencio, §12.7), solo se anota en el historial (`PROVIDER_PROCESS_FAILED`): el diagrama no tiene transición `SENT → FAILED`.

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

JSON real de cada evento (en especial *Delivered* y el campo del destinatario), nombre del parámetro del formulario, valores de `status` del API de logs, coincidencia de `client_reference`, servidor OAuth del centro de datos y esquema del encabezado (`Zoho-oauthtoken`), política de reintentos de los webhooks y existencia de una API de supresiones.

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
