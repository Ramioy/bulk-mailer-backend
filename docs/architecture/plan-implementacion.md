# Bulk Mailer — Plan de implementación

Base: arquitectura v2 (`arquitectura.md`) y decisiones (`decisiones.md`).
Criterio: primero el núcleo (reglas de idempotencia, estados y manifiesto), luego flujos completos con adaptadores
simulados, y al final los sistemas externos, que dependen de terceros.

## Etapa 1 — Base (nada depende de terceros)

| # | Componente | Contenido | Listo cuando… | Estado |
|---|---|---|---|---|
| 0 | Estructura del proyecto | NestJS 12 sobre Fastify, Node 26, pnpm, Vitest, oxlint, PostgreSQL 18 en Docker Compose. Carpetas `domain/`, `application/`, `ports/`, `adapters/` y un único punto de composición por configuración | `pnpm test` y `pnpm lint` corren en CI | ✅ |
| 1 | Dominio puro | Periodo (`YYYY-MM`, `America/Bogota`), bloques, validación del nombre (NFC, regex, catálogo, 150 caracteres), los 3 diagramas de estado, manifiesto versionado y diferencias `ADDED`/`REMOVED`, clasificación de respuestas de ZeptoMail, espera creciente, regla de repetidos (A1) | Pruebas unitarias con todos los ejemplos del contexto | ✅ |
| 2 | Puertos + adaptadores simulados | Las 14 interfaces; adaptadores en memoria (repositorio, archivos, cola, eventos, secretos) y simulados (`FakeContractSource`, `FakeEmailProvider`, `FakeFileInspector`, `FakeSendLookup`, `FakeSuppressionManager`, `FakeAuthenticator`, `FixedClock`, notificadores) | Pruebas de contrato reutilizables (repositorio, archivos, cola) pasan en memoria; los casos de uso de los pasos 5 y 6 se prueban con estos simulados | ✅ |

## Etapa 2 — Flujos de punta a punta con simulados

| # | Componente | Contenido | Listo cuando… | Estado |
|---|---|---|---|---|
| 3 | Persistencia | Migraciones PostgreSQL, `BulkMailerRepository`, UNIQUE (`sha256`, `attemptId`, `webhook_request_id`), auditoría solo-inserción también por permisos de BD | Pruebas de integración contra PostgreSQL en Docker | ✅ |
| 4 | Autenticación | `LocalJwtAuthenticator`, Argon2, comando de hash, renovación, protección de endpoints | Ningún endpoint sin token, salvo inicio de sesión | ✅ |
| 5 | Carga | `LocalVolumeFileStore`, `BasicPdfInspector`, `UploadReceipts`, `RemoveReceipt`, `GetBatchSummary`, *Refresh recipients*, endpoints REST | Lote real subido; resumen con válidos, inválidos y repetidos descartados | ✅ |
| 6 | Envío | `JobQueue` (tabla + `SKIP LOCKED`, ya implementada en el paso 3), `EventBus` como *outbox* en PostgreSQL, proceso en segundo plano, `ExecuteBatch` con bloqueo global, recuperación tras caída, SSE con reanudación por `Last-Event-ID` y cierre al vencer el token (D11, D12), `GET /executions/current` (D10), `PurgeBatchFiles` | Lote completo con `FakeEmailProvider`, incluidas pausas, detención tras 3 incidencias y caída simulada | ✅ |

## Etapa 3 — Sistemas externos

| # | Componente | Depende de | Estado |
|---|---|---|---|
| 7 | `HttpContractSource` para Tayrona (bloques 1–4 y 6) **y SAP** (bloque 5), mismo contrato §6.1 | ✅ contra el simulador `mocks/contracts-api.ts`. Falta validar con las APIs reales (pendientes externos #2 y #3) | ✅ |
| 8 | `ZeptoMailEmailProvider` según la documentación de Zoho, con redirección a buzón de prueba fuera de producción | ✅ contra el simulador `mocks/zeptomail-api.ts`. Falta validar con la cuenta real (pendientes #4 y #5) | ✅ |
| 9 | Webhook + `ProcessDeliveryEvent`, `ZeptoMailSendLookup` + `ReconcileSends` + `ResolveUncertain`, `UiAlertNotifier`, `ZeptoMailConsoleSuppressionManager` + liberación (D19), `ResendReceipt` | ✅ contra el simulador ampliado (logs, webhooks firmados, OAuth). Falta validar con la cuenta real los supuestos del paso 9. Ampliado con D20 (consultas solo con JWT), D21 (seguimiento cada minuto durante el lote, dos carriles) y D22 (verificación manual) | ✅ |
| 10 | ~~`SapContractSource`~~ cubierto por el paso 7 (misma interfaz) | API de SAP (pendiente #3) | ✅ |

## Etapa 4 — Cierre

| # | Componente | Estado |
|---|---|---|
| 11 | Administración: catálogo de conceptos y copia `bcc`, auditados (D23–D26) | ✅ |
| 12 | Preparación del piloto: validaciones de §12.7 con la cuenta real, respaldos de PostgreSQL, registros de operación, despliegue | ⏸ **En espera** (2026-10-31): se inicia cuando estén la cuenta de ZeptoMail y las APIs de Tayrona y SAP |
| — | Auditoría 2026-10-31 (`docs/audit/auditoria-2026-10-31.md`): bloques 1–8 (D32–D50) | ✅ en la rama `audita`, **pendiente de fusión a `main`**. Preguntas abiertas al usuario: (a) retención máxima de PDF de soportes que siguen "necesarios" (`FAILED` nunca reenviado, `PENDING` nunca corregido); (b) reconocer solas las alertas cuando su causa se resuelve; (c) B2: fricción de D31 al corregir el contrato de un soporte subiéndolo con el nombre arreglado |

## En paralelo

- Cliente web (repositorio aparte): arranca cuando el paso 5 tenga contrato OpenAPI.
- Pendientes externos (ruta crítica): aprobación de la cuenta de ZeptoMail, API de Tayrona, direcciones de remitente y copia.
