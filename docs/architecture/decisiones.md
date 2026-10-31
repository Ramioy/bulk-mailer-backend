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
