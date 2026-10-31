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
