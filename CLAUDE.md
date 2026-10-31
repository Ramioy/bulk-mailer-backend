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

Hechos y en `main`: pasos 0 a 9 (el 10 quedó cubierto por el 7), plantilla de correo configurable (D14), bus de eventos con *outbox* (D15, D16). Los pasos 7, 8 y 9 están construidos **contra simuladores** (`mocks/`, D17) porque las APIs reales y la cuenta de ZeptoMail aún no están disponibles. El paso 9 dejó supuestos por validar con la cuenta real (ver `decisiones.md`, "Paso 9") y la liberación de direcciones confirmada desde la consola (D19), porque Zoho no documenta API de supresiones. Después se agregaron D20 (toda consulta exige JWT; el webhook solo recibe), D21 (seguimiento cada minuto durante el lote y 30 min después; dos carriles de trabajo) y D22 (verificación manual de entrega).

**Siguiente: paso 11** (administración: catálogo de conceptos y copia `bcc`, auditados). Antes de empezar, el usuario debe dar el visto bueno.

### Punto de retorno para el paso 11

Último commit del paso 9: "Webhook queries with JWT, per-minute delivery check and manual verification (D20-D22)"; CI en verde, 411 pruebas.

Contexto que manda: `docs/context/04-file-name.md` §4.3 (catálogo: `clave`, `asunto`, `activo`; se agregan y se retiran conceptos, todo auditado; un concepto retirado deja de aceptarse en cargas posteriores y no afecta lo ya enviado), §10.5 (copia `bcc`: ajuste general desactivado por defecto, auditado con valor anterior; el valor vigente al iniciar una ejecución aplica a toda ella), §13 (la interfaz administra catálogo y copia; las cuentas de operador no) y §15 (auditoría).

Lo que **ya existe** (no rehacerlo):
- Dominio: `Concept`, `ConceptCatalog`, `INITIAL_CONCEPTS` (`src/domain/concept/concept.ts`); acciones de auditoría `CONCEPT_CHANGED` y `ARCHIVE_COPY_CHANGED` (`src/domain/audit/audit.ts`).
- Persistencia: `ConceptStore.list/save` y `SettingsStore.archiveCopyEnabled/setArchiveCopyEnabled`, en memoria y PostgreSQL (tablas `concepts` y `settings`).
- Uso: la carga valida contra el catálogo activo; el envío y el reenvío toman el `asunto`; `StartExecution` fija la copia al iniciar (rechaza con `ARCHIVE_COPY_NOT_CONFIGURED` si está activa sin `ARCHIVE_COPY_ADDRESS`); el resumen del lote muestra `archiveCopyEnabled`.

Lo que **falta**: casos de uso de administración (por el `SerialExecutor`, en `repository.transaction` con auditoría y eventos en `tx.outbox`), endpoints con JWT (la prueba `test/route-authentication.test.ts` los cubre sola) y pruebas.

**Preguntas para el usuario antes de implementar** (regla 2; proponer y esperar aprobación):
1. ¿Se puede **editar el `asunto`** de un concepto existente, o solo agregar y retirar? ¿Se puede **reactivar** un concepto retirado?
2. Validación de la `clave` nueva: proponer las mismas reglas del nombre de archivo (NFC, sin espacios dobles ni al borde, sin `CNCPT`/`CNTRT`, que quepa en los 150 caracteres) y que no exista ya.
3. Al **retirar** un concepto con soportes `PENDING` o `FAILED` ya cargados: ¿quedan como están (propuesta: sí, la regla habla de cargas posteriores) o pasan a `INVALID / UNKNOWN_CONCEPT` con nueva versión de manifiesto?
4. **Copia `bcc`**: rechazar activarla si no hay `ARCHIVE_COPY_ADDRESS` configurada (propuesta) y permitir el cambio durante una ejecución (aplica a la siguiente).
5. Endpoints propuestos: `GET /concepts`, `POST /concepts`, `PATCH /concepts/{clave}` (retirar, reactivar, asunto), `GET /settings/archive-copy` y `PUT /settings/archive-copy` con `{ "enabled": bool }` (respuesta con la dirección configurada).

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
- Los comandos que cambian un lote pasan por `SerialExecutor`; los cambios de BD van en `repository.transaction`, junto con sus eventos de dominio en `tx.outbox`. Todo cambio sobre soportes (también desde el carril de entrega y desde la ejecución en curso) pasa por el mismo `SerialExecutor` en tramos cortos, sin llamadas externas dentro (D21).
- Toda ruta nueva exige JWT salvo que se agregue a la lista explícita de `test/route-authentication.test.ts` con aprobación del usuario (D20).
- Sin reintentos automáticos de envíos de correo (C2). El reintento de entrega del *outbox* es interno y no envía correos.
