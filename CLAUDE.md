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

Hechos y en `main`: pasos 0 a 8 (el 10 quedó cubierto por el 7), plantilla de correo configurable (D14), bus de eventos con *outbox* (D15, D16). Los pasos 7 y 8 están construidos **contra simuladores** (`mocks/`, D17) porque las APIs reales y la cuenta de ZeptoMail aún no están disponibles.

**Siguiente: paso 9.** Antes de empezar, el usuario debe dar el visto bueno. Incluye:
- Webhook `POST /webhooks/zeptomail` (público, autenticado con HMAC `producer-signature` y encabezado `Authorization` propio, §12.5) + caso de uso `ProcessDeliveryEvent` (estado de entrega que solo avanza; solo cuentan los eventos del destinatario principal; duplicados por id de evento).
- `ZeptoMailSendLookup` (API de logs, OAuth) + `ReconcileSends` (resolver `UNCERTAIN` a los 5, 15 y 60 min; barrido de `SENT` sin confirmar) + `ResolveUncertain` manual con nota de evidencia + alerta `WEBHOOKS_NOT_RECEIVED` (§9.4).
- `ZeptoMailSuppressionManager` + liberación atómica de direcciones (§10.3) + lista de supresión local alimentada por rebotes duros y quejas.
- `ResendReceipt` (§10.4).
- Hacerlo como el paso 8: **primero** leer la documentación de Zoho (logs, webhooks, supresiones: enlaces en `docs/context/19-references.md`) con un agente `web-fetch`, y **ampliar el simulador** `mocks/zeptomail-api.ts` (logs por `client_reference`, envío de webhooks firmados, supresiones). No suponer formatos sin anotarlo como supuesto.

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
- Los comandos que cambian un lote pasan por `SerialExecutor`; los cambios de BD van en `repository.transaction`, junto con sus eventos de dominio en `tx.outbox`.
- Sin reintentos automáticos de envíos de correo (C2). El reintento de entrega del *outbox* es interno y no envía correos.
