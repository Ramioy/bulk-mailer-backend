# Bulk Mailer backend — instrucciones para Claude

Responde al usuario en **español**. El código, los identificadores y los mensajes de commit van en **inglés** (decisión D5).

## Reglas de trabajo acordadas con el usuario

1. **La arquitectura está pactada y no se rompe.** Hexagonal (puertos y adaptadores), monolito modular, una sola instancia, escala de ~300 soportes al mes en 6 lotes, sin tecnología desproporcionada. Cada tecnología va detrás de un puerto.
2. **Todo contexto o requisito nuevo se adapta a la arquitectura, no al revés.** Primero se clasifica (regla de negocio → núcleo; tecnología → adaptador; capacidad nueva → puerto nuevo), luego se informa el impacto. Si choca con lo acordado, se propone la adaptación **paso a paso** y **se espera la aprobación del usuario** antes de implementarla.
3. Toda decisión aprobada se registra en `docs/architecture/decisiones.md` (numeradas D1…, C1…, A1…, P1…). Los supuestos que tomes al implementar se anotan ahí y se le informan al usuario.
4. Se avanza por los pasos de `docs/architecture/plan-implementacion.md`, uno a la vez, y al terminar cada uno se pregunta antes de seguir.
5. Cada paso termina con: `pnpm lint && pnpm typecheck && pnpm test` (con PostgreSQL), commit, push a `main` y CI en verde.

## Documentos (leer antes de trabajar)

- `docs/architecture/arquitectura.md`: arquitectura v2 aprobada (diagramas, puertos, estados, errores).
- `docs/architecture/decisiones.md`: **fuente de verdad**; manda sobre `docs/context/` donde difieran.
- `docs/architecture/plan-implementacion.md`: plan y estado de cada paso.
- `docs/context/`: diseño funcional original del negocio (en inglés, identificadores en español).

## Estado al 2026-10-31

Hechos y en `main`: pasos 0 a 11 (el 10 quedó cubierto por el 7), plantilla de correo configurable (D14), bus de eventos con *outbox* (D15, D16). Los pasos 7, 8 y 9 están construidos **contra simuladores** (`mocks/`, D17) porque las APIs reales y la cuenta de ZeptoMail aún no están disponibles. El paso 9 dejó supuestos por validar con la cuenta real (ver `decisiones.md`, "Paso 9" y la lista §12.7, ampliada por la auditoría) y la liberación de direcciones confirmada desde la consola (D19). Después: D20 (toda consulta exige JWT; el webhook solo recibe), D21 (seguimiento por minuto; carriles de trabajo), D22 (verificación manual), D23–D26 (catálogo de conceptos y copia `bcc`, `AdminController`), y de la rama `simulacion` (nunca se fusiona con `main`): D27–D31.

### Auditoría del 2026-10-31 (rama `audita`, D32–D53)

`docs/audit/auditoria-2026-10-31.md`: auditoría escéptica del servicio (5 hallazgos altos, 15 medios, 12 bajos) y su corrección en **nueve bloques**, cada uno verificado con `lint + typecheck + test` con PostgreSQL. Las decisiones D32–D53 son la fuente de verdad de lo que sigue; 459 → 664 pruebas, ninguna borrada ni debilitada. Lo que cambió en la operación:

- **Robustez de la ejecución:** una excepción detiene el lote como `INTERNAL_ERROR` y libera el soporte (D32); `POST /executions/{id}/abort` (umbral `EXECUTION_ABORT_AFTER_MINUTES` o `force`); apagado cooperativo (D33, `SHUTDOWN_TIMEOUT_SECONDS`; Docker necesita `stop_grace_period: 40s`).
- **Nada se envía dos veces:** la evidencia tardía de un envío dado por no encontrado lo pasa a `SENT` (transición `FAILED → SENT` solo para ese caso, D34) con alertas `LATE_SEND_EVIDENCE` / `DUPLICATE_SEND_DETECTED`; el adaptador de logs nunca responde `NOT_FOUND` ante una forma inesperada (D35).
- **Convención de dos fases (D36):** consultas externas (fuente, inspector, proveedor, logs) **fuera** del `SerialExecutor`; decisión y escritura **dentro**, releyendo el estado. `test/support/serial-guard.ts` lo hace cumplir en las pruebas. Versión optimista en `receipts`/`batches` (`ConcurrentModificationError`) y manifiestos solo inserción (D37).
- **Trabajos:** cuatro carriles (`ExecutionLane`, `WebhookLane`, `LookupLane`, `FileLane`), `hasPending` para no duplicar periódicos, presupuestos (`DELIVERY_CHECK_BATCH_SIZE`, `RECONCILE_SWEEP_BATCH_SIZE`) (D38, D44); *outbox* con eventos muertos (`dead_at`, alerta `OUTBOX_EVENT_DEAD`, `GET /outbox/dead`, `POST /outbox/dead/{id}/retry`) (D39); encolado en la misma transacción vía `tx.jobs.enqueue` (D40).
- **Archivos (D41, D42, D51):** todo paso a `SENT` retira el archivo por trabajo `DELETE_RECEIPT_FILE`; purga por `PURGE_BATCH_FILES` solo de lo procesado; lote `STOPPED` sin nada pendiente se asienta a `COMPLETED`; barrido de huérfanos y de `.staging`; retención **indefinida** con liberación manual `POST /batches/{p}/{b}/release-files` que conserva los registros; `UNCERTAIN` cuenta como procesado (aprobado). El resumen muestra `fileError: FILE_NOT_AVAILABLE` aparte de `errorType`.
- **Alertas (D43–D46, D52):** `UNCERTAIN_UNRESOLVED`, `WEBHOOK_UNPARSED`, barrido con `SOFT_BOUNCE`, sin falsas alarmas de silencio; `GET /alerts?pending=&resolved=&type=&subject=&reference=&since=&limit=` (más recientes primero), `POST /alerts/{id}/acknowledge`; el sistema marca `resolvedAt` cuando la causa se resuelve, el reconocimiento es del operador (vista por defecto del cliente: `pending=true&resolved=false`).
- **Despliegue (D47–D49):** *lease* de instancia en BD (`InstanceLease`, `InstanceCoordinator`; solo el titular corre recuperación y carriles; `GET /instance`; estrategia *recreate*, ver `deploy/README.md`); carga por *streaming* a `.staging` con `UPLOAD_MAX_TOTAL_BYTES`/`UPLOAD_MAX_FILES` (413); `CORS_ALLOWED_ORIGINS` obligatorio en producción.
- **Cierre (D50, D53):** registro de operación JSON sin PII (consumidor del bus), `/health` con BD y volumen (503 `degraded`), límite de tasa en autenticación (`AUTH_RATE_LIMIT_PER_MINUTE`), retirar/resolver conflicto en cualquier periodo, limpieza diaria de `jobs`/`outbox` (`WORK_RETENTION_DAYS`), `MAX_ATTACHMENT_BYTES`; B2 cerrado: un nombre errado se corrige retirando el soporte y cargando el archivo con el nombre correcto. Reglas nuevas en `test/architecture.test.ts`: entrada no importa salida; composición solo tokens/tipos; ningún controlador toca el repositorio.

Preguntas abiertas de la auditoría: **ninguna**. Pendiente: fusión de `audita` a `main` (CI solo corre en `main` o en PR) y las validaciones de §12.7 con la cuenta real.

### ✅ Tercer mes simulado contra `main` auditado (2026-10-31) y D54–D55

`main` se llevó a la rama `simulacion` (merge `main → simulacion`, nunca al revés) y se corrió el mes con los escenarios de la auditoría (S6–S11 en `decisiones.md`; informe `sim/reports/2026-10-31-mes-simulado-3.md` en esa rama). Resultado: los 300 soportes igual que en el segundo mes; 10 de 12 escenarios de la auditoría de punta a punta; ningún defecto funcional. Dos defectos menores corregidos en `main` con aprobación del usuario: **D54** (`lastCounters` toma el último evento *con contadores*) y **D55** (`release-files` no reabre un lote `COMPLETED`). El usuario decidió **no repetir** el mes simulado por ahora.

### 🧩 Cliente web: repositorio aparte

Por decisión del usuario (2026-10-31) el cliente web vive en un repositorio propio (`bulk-mailer-frontend`, hermano de este), con pruebas e2e (Playwright) contra este backend corriendo en local con adaptadores `fake`. Este repositorio no cambia por el cliente; si el cliente necesita algo del backend, se propone aquí como decisión. Así nacieron **D56–D59** (CORS en el SSE, `since` en alertas, `INVALID_CREDENTIALS` único en el inicio de sesión, `GET /receipts/{sha256}/history`), aprobadas y hechas el 2026-10-31. El cliente aún no consume D59 ni el código único del 401.

### ⏭ PENDIENTE para la sesión siguiente (2026-11-01)

1. **Confirmar la demo local** del cliente en la máquina del usuario: `bulk-mailer-client/demo/up.sh` falló por el DNS de Docker Desktop (no por la demo); al correr, confirmar `demo/nginx.conf` (proxy `/api` y SSE), que aquí no pudo ejecutarse.
2. **Cliente web**: mostrar el historial por soporte (`GET /receipts/{sha256}/history`, D59) y usar el código único `INVALID_CREDENTIALS` del 401 (D58). Trabajo en `Ramioy/bulk-mailer-client`, delegable a Opus 5.5.
3. **Rama `simulacion`**: decidir si se rebasa con la autoría nueva de `main` (hoy conserva los dos commits viejos en su historia); el próximo `merge main → simulacion` traerá los mismos cambios con otro hash.
4. Propuestas de arquitectura entregadas en el chat, sin implementar y sin decisión: separación en dos contextos (correo transaccional y soportes) y núcleo multicliente con cola. Si se aprueban, van como D60… y después del piloto.

### ⏸ EN ESPERA: paso 12

**El paso 12 (preparación del piloto) está en espera por decisión del usuario (2026-10-31).** No empezarlo, ni siquiera las partes que no dependen de terceros, hasta que el usuario avise que tiene:

1. la **cuenta de ZeptoMail** aprobada,
2. la **API de Tayrona** y
3. la **API de SAP**.

Contenido del paso 12: validaciones de §12.7 con la cuenta real (demora de aparición en los logs para calibrar `RECONCILE_DELAYS_MINUTES`, respuesta a direcciones suprimidas, 429/5xx y límites de uso de la API de logs, reintentos de webhooks, JSON real de los eventos, forma del campo `to` y paginación de `GET /v1.1/email`, límite del mensaje codificado, centro de datos, filtro de `client_reference`, alcance OAuth de supresiones) y los supuestos del paso 9; respaldos de PostgreSQL; despliegue (`stop_grace_period`, estrategia *recreate*, cierre de conexión del 413 detrás del *proxy*). Los registros de operación ya existen (D50).

**Preguntas abiertas al usuario** (el usuario construye las APIs de Tayrona y SAP):
- ¿El token de servicio de las APIs de contratos va como `Authorization: Bearer <token>`? ¿La respuesta 200 trae exactamente `contrato`, `activo`, `nombre_conjunto`, `correo`?
- Pendiente para el piloto: calibrar el umbral de revisiones incrementales con PDF reales (los PDF linealizados traen dos `%%EOF`).

## Entorno (contenedor nuevo)

El contenedor de una sesión nueva no trae Node 26 ni Docker corriendo:

```bash
curl -sSfLO https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
mkdir -p /opt/node26 && tar -xJf node-v26.13.0-linux-x64.tar.xz -C /opt/node26 --strip-components=1
export PATH=/opt/node26/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable --install-directory /opt/node26/bin pnpm
pnpm install
(dockerd > /tmp/dockerd.log 2>&1 &)   # luego: pnpm db:up
```

- Pruebas con PostgreSQL: `TEST_DATABASE_URL=postgres://bulk_mailer:bulk_mailer_local@localhost:5432/bulk_mailer_test pnpm test` (o `cp .env.example .env && pnpm test:db`). Sin esa variable, las pruebas de PostgreSQL se omiten.
- Para detener la app o los simuladores, usar el PID (`echo $! > /tmp/app.pid`). **No usar `pkill -f` con un patrón que aparezca en el propio comando**, porque mata la shell.
- Identidad de git del repositorio: `Yoimar <yoimar.mb@outlook.com>`.

## Convenciones del código

- `src/domain`: TypeScript puro. `src/ports`: interfaces. `src/application`: casos de uso. `src/adapters`: entrada (HTTP, trabajos) y salida. `src/app.module.ts` es el **único** punto de composición. `test/architecture.test.ts` hace cumplir las capas.
- Errores esperados como `Result` con tipos en inglés (`SOURCE_UNAVAILABLE`, `PROVIDER_ACCOUNT`…), nunca excepciones.
- Los adaptadores nuevos pasan las pruebas de contrato de `test/contracts/` cuando existen.
- Los comandos que cambian un lote pasan por `SerialExecutor`; los cambios de BD van en `repository.transaction`, junto con sus eventos de dominio en `tx.outbox`. Todo cambio sobre soportes (también desde los carriles de entrega y desde la ejecución en curso) pasa por el mismo `SerialExecutor` en tramos cortos, sin llamadas externas dentro (D21, D36).
- Toda ruta nueva exige JWT salvo que se agregue a la lista explícita de `test/route-authentication.test.ts` con aprobación del usuario (D20).
- **Dos fases (D36):** ningún caso de uso llama a un puerto externo (fuente, inspector, proveedor, logs) dentro de `serial.run`; la fase de escritura relee el estado y guarda con la versión leída (D37). Los trabajos se encolan con `tx.jobs.enqueue` dentro de la transacción (D40); los archivos se retiran por trabajo, nunca dentro de la transacción (D41).
- Los controladores solo hablan con casos de uso y puertos; no importan `adapters/outbound` ni el repositorio (`test/architecture.test.ts`).
- Sin reintentos automáticos de envíos de correo (C2). El reintento de entrega del *outbox* es interno y no envía correos.
