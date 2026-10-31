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
