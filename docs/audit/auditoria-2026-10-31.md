# Auditoría del servicio Bulk Mailer — 2026-10-31

**Rama:** `audita` (desde `main`, commit `c0c3fd2`). **Estado verificado antes de auditar:** `pnpm lint`, `pnpm typecheck` y `pnpm test` con PostgreSQL en verde (40 archivos, 459 pruebas).

**Perfil de la auditoría:** escéptico y pesimista. Se partió del supuesto de que el servicio tiene errores y cada hipótesis se intentó **demostrar** antes de reportarla. Las que no pudieron demostrarse se marcan como *riesgo* y no como *falla*.

**Alcance:** diseño del servicio, separación de responsabilidades (hexagonal, D-decisiones) y excepciones no contempladas en el flujo operativo. **Fuera de alcance:** las APIs de Tayrona/SAP y la cuenta de ZeptoMail no existen todavía; sus adaptadores se juzgan por el contrato con el puerto y por los supuestos declarados, no por su comportamiento real.

**Este informe no cambia código.** Toda adaptación propuesta espera la aprobación del usuario (regla 2) y, de aprobarse, se registraría en `decisiones.md`.

---

## 1. Resumen ejecutivo

El núcleo es sólido en lo que se diseñó para hacer: identidad por SHA-256, manifiesto versionado, intento registrado antes de llamar al proveedor, *outbox* transaccional, diagramas de estado aplicados con `assertTransition`, webhook con HMAC y `ts`, toda ruta con JWT salvo la lista explícita. Las 459 pruebas cubren bien el **camino normal y los fallos previstos** del proveedor.

Lo que falla es lo que pasa **fuera del guion**: errores internos durante la ejecución, evidencia que llega tarde, trabajos que se acumulan, reinicios y despliegues, archivos que nadie borra, y una regla (D21, "tramos cortos sin llamadas externas") que el propio código incumple en cuatro casos de uso.

| Gravedad | Cant. | Hallazgos |
|---|---|---|
| **Alta** | 5 | A1 duplicado por evidencia tardía · A2 bloqueo total ante excepción en la ejecución · A3 llamadas externas dentro del `SerialExecutor` · A4 `NOT_FOUND` por forma inesperada de los logs → duplicado · A5 acumulación del carril de entrega |
| **Media** | 15 | M1 a M15 (retención de PDF, `UNCERTAIN` sin seguimiento, barrido ciego a `SOFT_BOUNCE`, falsa alarma, `FAILED` fuera de manifiesto, webhook sin eventos en silencio, *outbox* bloqueado por eventos envenenados, dos instancias, apagado no cooperativo, memoria, lecturas fuera de la sección crítica, purga de soportes no alcanzados, CORS, alertas sin reconocimiento, encolado tras *commit*) |
| **Baja** | 12 | B1 a B12 (consistencia de datos, fricción operativa, fugas de responsabilidad en controladores, crecimiento sin límite, etc.) |

**Los tres que, de materializarse, violan la garantía principal del sistema ("un contenido no se envía dos veces", §9.1):** A1, A4 y, de forma indirecta, M8. **El que más probablemente ocurrirá en el piloto:** A2 (cualquier excepción no prevista) y M6 (el JSON real del webhook no coincide con el supuesto y nadie se entera).

---

## 2. Método

1. Lectura completa de `docs/architecture/`, `docs/context/` y de los 9 054 renglones de `src/` (dominio, puertos, aplicación, adaptadores, composición, configuración), más `test/`, `deploy/`, CI y simuladores.
2. Contraste de cada caso de uso contra los diagramas de estado (§5–§7), las decisiones D1–D31 y el flujo operativo (§8–§10).
3. Para cada hipótesis grave, una **prueba de borrador** con los *fixtures* existentes (en memoria), ejecutada y luego descartada (no forma parte de la suite). Los resultados se transcriben en §7. Lo que dice "**verificado**" fue reproducido; lo que dice "**por código**" se sostiene en lectura de las líneas citadas.

Clasificación según la regla 2: **núcleo** (regla de negocio), **adaptador** (tecnología), **puerto** (capacidad nueva).

---

## 3. Hallazgos de gravedad alta

### A1 — La evidencia tardía de que un correo sí salió se ignora si el soporte ya quedó `FAILED` → reenvío duplicado

**Estado:** corregido en `audita` (D34, commit `9afc980`). El resumen del lote ya no esconde `NOT_FOUND_AT_PROVIDER` detrás de `FILE_NOT_AVAILABLE`: muestra el error propio y `fileError` aparte (D42, commit `a960b8d`). La evidencia de un intento **anterior** cuando el último también quedó no encontrado ahora también confirma el envío (D50, commit `078ccbc`).

- **Clasificación:** núcleo (máquina de estados del soporte y `applyToReceipt`).
- **Evidencia:** `src/application/delivery/apply-delivery-event.ts:107` — todo evento de entrega del último intento sobre un soporte que no está `SENT`, `SENDING` ni `UNCERTAIN` se anota como `DELIVERY_EVENT_IGNORED` y no hace nada más. `src/domain/receipt/receipt-state.ts` no tiene transición `FAILED → SENT`.
- **Escenario:** un envío queda `UNCERTAIN` (timeout). A los 60 min la conciliación no lo encuentra en los logs (`EL_404`) y lo marca `FAILED / NOT_FOUND_AT_PROVIDER`. A las 2 h llega el webhook *Delivered* (o aparece en los logs) con ese `client_reference`. El soporte sigue `FAILED`, con destinatario y archivo, **listo en el manifiesto**; la siguiente ejecución lo envía otra vez.
- **Verificado (§7, H1):** `results: ['RECORDED'], state: 'FAILED', lastHistory: 'DELIVERY_EVENT_IGNORED', alerts: []`.
- **Por qué importa:** §12.7 lo nombra como el riesgo #1 ("un `EL_404` prematuro marca como no enviado algo que sí salió → duplicado") y la mitigación de las tres consultas **no basta si la demora real supera 60 min**, que es justamente lo que el paso 12 va a medir. El sistema ya tiene la prueba en la mano y la tira. Lo mismo aplica a `ResolveUncertain` con `NOT_SENT` si el operador se equivoca.
- **Adaptación propuesta (paso a paso, por aprobar):**
  1. Núcleo: un evento de entrega del **último intento** sobre un soporte `FAILED` cuyo `errorType` sea `NOT_FOUND_AT_PROVIDER` (o cuyo intento tuviera `outcome: UNCERTAIN`) **sí cambia el estado**: `FAILED → SENT` con la entrega que informe el evento, en el historial `SENT confirmed late by …`.
  2. Núcleo: alerta nueva `LATE_SEND_EVIDENCE` (sujeto: hash; detalle: intento, cuándo se marcó fallido, qué llegó), porque si entre medias ya hubo otra ejecución, el cliente recibió dos correos y hay que avisarle al operador.
  3. Núcleo: si el soporte ya está `SENDING`/`SENT` por un **intento posterior** cuando llega la evidencia del anterior, no tocar el estado pero **sí** alertar `DUPLICATE_SEND_DETECTED` (hoy se anota `DELIVERY_EVENT_IGNORED … of an older attempt` y nada más, `apply-delivery-event.ts:90-93`).
  4. Documentar en `arquitectura.md` §5 la transición nueva y en `decisiones.md` como D32.

### A2 — Una excepción dentro del trabajo `EXECUTE_BATCH` deja el sistema bloqueado hasta reiniciar el proceso

**Estado:** corregido en `audita` (D32, commit `0dca3db`). La misma falla en el reenvío (una excepción dejaba el soporte `SENDING` hasta reiniciar) quedó corregida con D36 (commit `483b66e`).

- **Clasificación:** adaptador de entrada (`JobRunner`) + núcleo (no hay ruta de "abortar/desbloquear").
- **Evidencia:** `src/adapters/inbound/jobs/job-runner.ts:44-49` — el trabajo se marca `FAILED` y "no se reintenta". Nada toca la ejecución ni el lote. `refuseBatchCommand` (`receipt-dependencies.ts:36-41`) y `ResendReceipt` rechazan todo mientras `executions.running()` devuelva algo. `RecoverAfterCrash` solo corre en `onApplicationBootstrap` (`background-work.ts:33-38`).
- **Escenario:** error de disco al leer el PDF (`fileStore.read` lanza algo distinto de `ENOENT`), BD caída un instante, `DomainError` por una transición inesperada (p. ej. M11), un `undefined` no previsto. La ejecución queda `RUNNING` para siempre: **ningún operador puede cargar, retirar, enviar, reenviar ni resolver conflictos en ningún lote**, el soporte que estaba en curso queda `SENDING` (ni `UNCERTAIN` ni nada) y el SSE nunca recibe `FINISHED`. Único remedio: reiniciar el contenedor.
- **Verificado (§7, H2):** `stillRunning: true, uploadError: 'EXECUTION_IN_PROGRESS', startError: 'EXECUTION_IN_PROGRESS', states: ['SENDING', 'PENDING'], nextJob: undefined`.
- **Adaptación propuesta:**
  1. Núcleo: `RunExecution.execute` envuelve el bucle en `try/catch`; ante una excepción no clasificada, el soporte en curso pasa a `UNCERTAIN` si ya se llamó al proveedor o a `PENDING` si no (hoy se sabe por la posición del fallo), y el lote termina `STOPPED / INTERNAL_ERROR` con alerta `BATCH_STOPPED` y evento `FINISHED`. Es exactamente lo que ya hace `RecoverAfterCrash`, pero sin esperar al reinicio.
  2. Adaptador: `JobRunner` sigue marcando el trabajo fallido, pero el *handler* ya no deja estado inconsistente.
  3. Operación: comando administrativo `POST /executions/{id}/abort` (JWT, auditado `EXECUTION_ABORTED`, solo si lleva más de N minutos sin eventos de progreso) que ejecute la misma recuperación. Sin esto, el "reinicio" sigue siendo el único botón de emergencia y TI no siempre está.
  4. Prueba: "una excepción en medio del lote lo detiene como `INTERNAL_ERROR` y libera el bloqueo global".

### A3 — Cuatro casos de uso hacen llamadas externas **dentro** del `SerialExecutor`, en contra de D21

**Estado:** corregido en `audita` (D36, commit `483b66e`).

- **Clasificación:** núcleo (orquestación de los casos de uso).
- **Evidencia:** `upload-receipts.ts:97` (todo `run` dentro de `serial.run`, y `evaluate` → `cachedResolver` → `receipt-dependencies.ts:48` consulta Tayrona/SAP, hasta 5 s por contrato); `refresh-recipients.ts:20-31` (ídem, un contrato por soporte); `resolve-duplicate-conflict.ts:53` (consulta la fuente); **`resend-receipt.ts:48, 63, 92`: la consulta a la fuente y el envío al proveedor (hasta 30 s de timeout) ocurren con el ejecutor tomado.**
- **Escenario:** Tayrona cae. El operador carga 60 archivos con 60 contratos distintos: 60 × 5 s = **5 minutos** con el ejecutor bloqueado. Durante esos 5 minutos el carril de entrega no puede aplicar webhooks (`ProcessDeliveryEvent` usa `serial.run`), la conciliación no escribe, la verificación manual no audita, y toda petición HTTP de comando se encola. Con un reenvío, un *timeout* de ZeptoMail bloquea 30 s todo el sistema.
- **Por código.** D21 dice: "todo cambio sobre soportes pasa por el mismo `SerialExecutor` en tramos cortos, **sin llamadas externas dentro**". `RunExecution` sí lo cumple (`write()` por tramos, `run-execution.ts:150-154`); los comandos HTTP no.
- **Adaptación propuesta:**
  1. Núcleo: separar en cada comando la fase de **consulta** (fuente, inspector, hash) de la fase de **decisión y escritura**. Patrón: fuera del ejecutor se resuelve todo lo externo; dentro, en una sola transacción corta, se relee el estado (`receipts.get`), se vuelve a aplicar `decideUpload`/`refuseBatchCommand` y se escribe. Si el estado cambió entre fases, se repite o se rechaza con `409`.
  2. `ResendReceipt`: tres tramos como la ejecución (registrar `SENDING` → enviar fuera → registrar resultado), igual que `RunExecution.sendOne`.
  3. Prueba de arquitectura nueva: ningún método de los puertos `ContractSource`, `EmailProvider`, `SendLookup`, `FileInspector` se invoca dentro de un `serial.run` (se puede verificar en pruebas con un `SerialExecutor` instrumentado que falle si una dependencia externa simulada se llama mientras está ocupado).

### A4 — El adaptador de logs responde `NOT_FOUND` ante respuestas con forma inesperada → `FAILED` → duplicado

**Estado:** corregido en `audita` (D35, commit `14c2216`).

- **Clasificación:** adaptador de salida (`ZeptoMailSendLookup`), con efecto en el núcleo.
- **Evidencia:** `src/adapters/outbound/zeptomail/zeptomail-send-lookup.ts:60-83`. Si la lista trae entradas pero ninguna coincide con `to.toLowerCase() === recipient` (porque `to` venga como `"Nombre <correo>"`, como objeto `{ email_address: { address } }` —el mismo formato que usa el envío—, o como arreglo), o si ninguna trae `email_reference` como texto, el resultado es **`NOT_FOUND`**, no `UNAVAILABLE`. El comentario dice "never resolves a send by guessing", pero **sí falla adivinando**. En la última conciliación (`reconciliation.ts:70-72`) `NOT_FOUND` + `final` = `FAILED / NOT_FOUND_AT_PROVIDER` y el soporte vuelve al manifiesto.
- **Riesgo (no verificable sin la cuenta):** el formato del campo `to` en la lista **no está documentado** (decisiones, "Paso 9: supuestos"). Si difiere del supuesto, **todos** los `UNCERTAIN` del piloto se marcarán fallidos a los 60 min aunque hayan salido.
- **Adaptación propuesta:**
  1. Adaptador: `NOT_FOUND` **solo** cuando la API responde `EL_404` (línea 56) o cuando la lista es un arreglo **vacío**. Lista no vacía sin coincidencia utilizable → `UNAVAILABLE` con detalle `"logs API: N entries, none matched recipient"`, que deja el soporte `UNCERTAIN` y a la vista (regla ya existente: "lo no documentado es incierto").
  2. Adaptador: aceptar `to` como texto, objeto o arreglo de objetos (`email_address.address`, `address`, `email`).
  3. Paso 12 (§12.7): añadir a la lista de validaciones "forma exacta de `to` en `GET /v1.1/email`" y una prueba de contrato del adaptador con la respuesta real capturada.

### A5 — El carril de entrega se acumula: `CHECK_RECENT_SENDS` se encola cada minuto sin deduplicar y sin límite de costo

**Estado:** corregido en `audita` (D38, commit `a77596b`).

- **Clasificación:** adaptador de entrada (`BackgroundWork`) + núcleo (`DeliveryFollowUps`, `CheckRecentSends`).
- **Evidencia:** `background-work.ts:44-50` encola cada 60 s mientras `active()`; `delivery-follow-ups.ts:35-39` no comprueba si ya hay uno `READY` o en curso; `reconciliation.ts:136-148` consulta **cada intento pendiente de entrega** de la ejecución en curso y de las terminadas en los últimos 30 min, 2 llamadas HTTP por soporte (lista + detalle), 5 s de timeout cada una (`contractApiTimeoutMs` no; `zeptomail.timeoutMs` = 30 s); `postgres-job-queue.ts:36-47` entrega por `run_at, seq`, así que los `CHECK_RECENT_SENDS` atrasados compiten en igualdad con `PROCESS_DELIVERY_EVENT`.
- **Escenario:** lote de 300 soportes, ZeptoMail acepta todos; los webhooks *Delivered* tardan minutos. A los 5 min hay ~250 `UNCONFIRMED`: un ciclo son 500 llamadas; si la API de logs responde en 300 ms, 150 s por ciclo → cada ciclo dura más que el intervalo → **los trabajos se apilan** y los webhooks reales (que sí actualizarían la supresión antes del siguiente envío al mismo correo) esperan detrás. Si Zoho limita (429, no documentado, §12.7) el costo es `UNAVAILABLE` masivo; peor: si el límite de uso es compartido con la API de envío, **el propio seguimiento provoca `UNCERTAIN` en los envíos** y detiene el lote a la 3.ª incidencia.
- **Por código.** D21 anota el costo ("2 llamadas por soporte pendiente") pero no lo acota.
- **Adaptación propuesta:**
  1. Núcleo: `requestRecentCheck` no encola si ya existe un `CHECK_RECENT_SENDS` `READY` o `CLAIMED` (añadir `JobQueue.hasPending(type)` al puerto; es una capacidad pequeña y genérica).
  2. Núcleo: presupuesto por ciclo (p. ej. 20 soportes, los más antiguos primero, configurable) y **prioridad**: los `PROCESS_DELIVERY_EVENT` antes que cualquier chequeo (columna `priority` en `jobs` o dos carriles de entrega: *webhooks* y *consultas*).
  3. Núcleo: *backoff* del seguimiento cuando la API de logs responde `UNAVAILABLE`/429 en un ciclo (saltar el siguiente).
  4. Paso 12: preguntar a Zoho los límites de uso de la API de logs y si comparten cuota con el envío; mientras no se sepa, `DELIVERY_CHECK_INTERVAL_SECONDS` conservador (300) en producción.

---

## 4. Hallazgos de gravedad media

### M1 — PDFs retenidos indefinidamente en el volumen (D4 y §15 incumplidos)

**Estado:** corregido en `audita` (D41, commit `086a2db`). Retirar un soporte y resolver un conflicto también borran su archivo por trabajo, no después del *commit* (D50, commit `078ccbc`).

- **Clasificación:** núcleo.
- **Evidencia:** la purga solo ocurre al pasar a `COMPLETED` (`run-execution.ts:259-266`) y en un reenvío `SENT` (`resend-receipt.ts:144`). `confirmSent` (`apply-delivery-event.ts:29-42`), `checkAttempt` y `ResolveUncertain` (`resolve-uncertain.ts:26-29`) llevan `UNCERTAIN → SENT` **sin tocar `fileAvailable` ni el archivo**.
- **Escenarios verificados (§7, H4):** lote de 3 que se detiene por 3 inciertos seguidos (`STOPPED`); la conciliación confirma los 3 como `SENT/ACCEPTED`. Resultado: `file=true` en los tres, 3 PDF en el volumen, y `Send` responde `NOTHING_TO_SEND`: **el lote nunca llegará a `COMPLETED` y nadie borrará esos archivos**. Igual con un reenvío `UNCERTAIN` confirmado después. Además, si el proceso cae entre el *commit* de `fileAvailable=false` y `purgeBatch` (líneas 262 y 266 son transacciones distintas), quedan archivos huérfanos que ningún proceso vuelve a mirar.
- **Impacto:** datos financieros y personales (Ley 1581) retenidos sin fin, en contra de D4 y de "no se guardan copias" de §15.
- **Adaptación propuesta:** (1) regla de núcleo: **todo** paso a `SENT` (por resultado, conciliación, webhook o resolución manual) marca `fileAvailable=false` y encola un trabajo `DELETE_RECEIPT_FILE` (no borrar dentro de la transacción, sino después, idempotente); (2) un lote queda `COMPLETED` también cuando, estando `STOPPED`, **ya no quede nada listo ni incierto** (evaluado al resolver el último `UNCERTAIN`), lo que dispara la purga; (3) trabajo periódico `PURGE_ORPHAN_FILES` que recorre el volumen y borra lo que no corresponda a un soporte con `fileAvailable=true`.

### M2 — Un `UNCERTAIN` que la última consulta no pudo resolver queda así para siempre, sin alerta

**Estado:** corregido en `audita` (D43, commit `88dd0c4`).

- **Evidencia:** `reconciliation.ts:65-68` (`UNAVAILABLE` → solo historial); `SweepUnconfirmed` solo mira `SENT` (línea 180); `CheckRecentSends` solo 30 min. No hay alerta de "`UNCERTAIN` sin resolver".
- **Verificado (§7, H11):** tras la consulta final con la API caída: `state: 'UNCERTAIN', pendingJob: undefined, alerts: []` incluso 100 h después.
- **Impacto:** la decisión "el operador puede resolverlo a mano" exige que alguien lo vea. Si no, el cliente nunca recibe su soporte y el sistema no lo dice.
- **Propuesta:** alerta `UNCERTAIN_UNRESOLVED` cuando la consulta final no resuelve; el barrido horario también relee los `UNCERTAIN` con más de 60 min (sin marcarlos fallidos: solo confirma si aparecen).

### M3 — El barrido ignora `SOFT_BOUNCE`: un rebote duro cuyo webhook se perdió nunca se detecta ni suprime

**Estado:** corregido en `audita` (D44, commit `e16c4d0`).

- **Evidencia:** `reconciliation.ts:181` (`if (receipt.deliveryState !== 'UNCONFIRMED') continue`); `isPendingDelivery` sí incluye `SOFT_BOUNCE` pero el barrido lo filtra antes.
- **Verificado (§7, H8):** `SOFT_BOUNCE` de 10 h, logs dicen `HARD_BOUNCE`: `lookedUp: 0`.
- **Impacto:** la dirección no entra a la lista local; el próximo lote le vuelve a enviar (ZeptoMail la descarta en silencio o rechaza; §12.7), y el operador no ve "No entregado".
- **Propuesta:** el barrido usa `isPendingDelivery` (incluye `SOFT_BOUNCE`) con la misma ventana N–72 h.

### M4 — Falsa alarma `WEBHOOKS_NOT_RECEIVED` cuando nada llegó a salir

**Estado:** corregido en `audita` (D44, commit `e16c4d0`).

- **Evidencia:** `reconciliation.ts:195` cuenta intentos con `outcome: UNCERTAIN` como "esperan webhook" aunque el soporte haya terminado `FAILED / NOT_FOUND_AT_PROVIDER`.
- **Verificado (§7, H9):** un solo envío incierto, no encontrado, luego fallido → a las 10 h: `WEBHOOKS_NOT_RECEIVED: 1 receipt(s) sent … and no webhook in 6 h`.
- **Impacto:** el operador revisa el *endpoint* sin motivo; una alerta que miente pierde credibilidad justo cuando haga falta.
- **Propuesta:** filtrar por el estado actual del soporte (`SENT`), no por el resultado del intento.

### M5 — Un `FAILED` producido por conciliación o resolución manual no entra a ningún manifiesto hasta un comando ajeno

- **Evidencia:** `reconciliation.ts:fail()` (líneas 243-255) y `resolve-uncertain.ts` no llaman a `publishNextManifest`; `ResendReceipt` sí (D7c, `resend-receipt.ts:125`), por lo que la regla se aplica de forma inconsistente.
- **Verificado (§7, H3):** reenvío incierto → fallido por conciliación: `startError: 'NOTHING_TO_SEND'`, re-subir el mismo PDF responde `DUPLICATE`, el resumen lo muestra en *needsCorrection* con `NOT_FOUND_AT_PROVIDER` —**sin acción posible desde esa lista**— y solo *Refresh recipients* lo desbloquea. Para un lote normal el problema queda tapado por A2/A1 (hay que volver a subir el archivo, y eso republica), pero la regla del núcleo sigue mal: el estado "listo" depende de qué comando pasó después.
- **Propuesta:** regla única en el núcleo: **todo cambio que vuelva a un soporte "listo" o "no listo" publica una versión nueva del manifiesto de su lote** (conciliación, resolución manual, supresión de una dirección, liberación). Alternativa más simple: que `isReadyToSend` no dependa del manifiesto para soportes `FAILED` y que `GetBatchSummary` los muestre como "listos, requiere nueva versión" con un botón explícito.

### M6 — Un webhook que llega pero no produce ningún evento correlacionable pasa en silencio

**Estado:** corregido en `audita` (D45, commit `376946a`).

- **Evidencia:** `zeptomail-webhook.ts:106,111` descartan en silencio los mensajes sin `client_reference` o con `object` desconocido; `ProcessDeliveryEvent` marca `processedAt` con `results: []` y no alerta; la alerta "silencio total" (M4) diría "revise el *endpoint*" aunque el *endpoint* esté recibiendo.
- **Por código.** Es el escenario **más probable** del piloto: §12.7 reconoce que no hay ejemplo completo del JSON real y el *parser* es un supuesto.
- **Propuesta:** alerta `WEBHOOK_UNPARSED` (una por `webhook_request_id`) cuando un webhook válido produce cero eventos o eventos sin `attemptId` conocido (`UNKNOWN_ATTEMPT` también hoy es silencioso, `apply-delivery-event.ts:55`); el texto de `WEBHOOKS_NOT_RECEIVED` debe distinguir "no llegó nada" de "llegó pero no se entendió".

### M7 — El *outbox* se bloquea en la cabeza cuando se acumulan eventos envenenados

**Estado:** corregido en `audita` (D39, commit `8164d89`).

- **Evidencia:** `outbox-relay.ts:25` salta los eventos con `attempts >= 10` pero `lockPending` (`postgres-bulk-mailer-repository.ts:485`) los sigue devolviendo dentro del `LIMIT 50`. Con 50 eventos envenenados no despachados, **ningún evento posterior se entrega nunca**: ni alertas, ni `RECEIPT_UNCERTAIN` (sin conciliación), ni `WEBHOOK_RECEIVED` (sin procesamiento de webhooks).
- **Por código.** Un consumidor roto (p. ej. un `payload` malformado por una migración) lo provoca sin ruido.
- **Propuesta:** `lockPending` excluye `attempts >= 10` (o columna `dead_at`), alerta `OUTBOX_EVENT_DEAD` al décimo fallo, y una consulta `GET /outbox/dead` (JWT) para verlos.

### M8 — Nada impide dos instancias; un *rolling restart* corrompe el lote en curso

**Estado:** corregido en `audita` (D47, commit `cd783d8`).

- **Evidencia:** `SerialExecutor` es en memoria (`serial-executor.ts`); `RecoverAfterCrash` marca `INTERRUPTED` a **cualquier** ejecución `RUNNING` y `UNCERTAIN` a **todo** `SENDING` al arrancar (`recover-after-crash.ts:14-27`), sin comprobar si pertenecen a un proceso vivo; `releaseAbandoned` libera **todos** los `CLAIMED` (`postgres-job-queue.ts:58-64`).
- **Escenario:** despliegue con la instancia nueva arrancando antes de que la vieja termine (comportamiento por defecto de la mayoría de orquestadores), o alguien arranca una segunda réplica "para pruebas" contra la misma BD. La nueva marca el lote de la vieja como interrumpido y sus soportes `UNCERTAIN`; la vieja sigue enviando y sobrescribe (`SENDING→SENT` sobre un objeto leído antes, M11); al final `finish` lanza `DomainError` (`STOPPED → COMPLETED` no existe) y cae en A2.
- **Por código.** C5 exige una instancia; nada lo hace cumplir.
- **Propuesta:** *lease* de instancia en BD (`pg_advisory_lock` al arrancar el `BackgroundWork`, o fila `instance_lease` con latido); la segunda instancia arranca sin carriles y lo registra; la recuperación solo actúa si el *lease* anterior expiró. Documentar en `deploy/` que la estrategia es *recreate*, no *rolling*.

### M9 — El apagado no es cooperativo: todo despliegue en medio de un lote produce `INTERRUPTED` + `UNCERTAIN`

**Estado:** corregido en `audita` (D33, commit `b908cf9`).

- **Evidencia:** `background-work.ts:55` espera `runner.stop()`, que espera el `drain()` **completo** (`job-runner.ts:60-62`); `RunExecution` no consulta ninguna señal de parada en su bucle (`run-execution.ts:52-56`). Docker envía `SIGKILL` 10 s después de `SIGTERM`.
- **Impacto:** cada reinicio durante un lote de 300 (que con pausas de 1 s y esperas de 30-60 s dura varios minutos) deja un soporte `UNCERTAIN` y el lote detenido; es decir, el flujo de "caída" se convierte en el flujo **normal** de despliegue.
- **Propuesta:** `RunExecution` recibe un `AbortSignal`; al apagar, termina el soporte en curso (registra su resultado), marca el lote `STOPPED / INTERRUPTED` **limpiamente** (sin `UNCERTAIN`) y emite `FINISHED`; `stop()` espera como máximo el tiempo de un envío.

### M10 — Memoria: hasta 300 archivos × 15 MB en RAM por petición, sin tope total

**Estado:** corregido en `audita` (D48, commit `28b8e54`).

- **Evidencia:** `bootstrap.ts:28` (`files: 300`, `fileSize: 15 MB + 1`); `receipts.controller.ts:70-75` acumula **todos** los `part.toBuffer()` antes de llamar al caso de uso; `upload-receipts.ts` conserva `file.content` de todos los archivos hasta el final del comando (sección crítica, A3).
- **Impacto:** 4,5 GB teóricos por petición; con dos operadores subiendo a la vez, caída por OOM que a su vez dispara A2/M8. Al volumen real (300 PDF pequeños) no pasará, pero el límite no protege nada.
- **Propuesta:** límite total por petición (p. ej. 200 MB) en el adaptador HTTP; procesar por archivo (hash, inspección, guardado en disco temporal) antes de leer el siguiente.

### M11 — Lecturas fuera de la sección crítica y *upserts* de fila completa: "último escritor gana"

**Estado:** corregido en `audita` (D37, commit `6e1c72d`).

- **Evidencia:** `run-execution.ts:68,81` lee el soporte **fuera** de `write()` y lo guarda dentro con `{...receipt}`; `recordOutcome` guarda `{...sending}` leído minutos antes (tras la espera creciente); `finish` lee `batch` fuera (línea 239) y lo guarda dentro; `receipts.save` es un `INSERT … ON CONFLICT DO UPDATE` de **todas** las columnas sin versión de fila; `saveManifest` hace `ON CONFLICT (period, block, version) DO UPDATE` (`postgres-bulk-mailer-repository.ts:245`): la "nunca dos manifiestos con la misma versión" de D-paso 5 **no está protegida por la BD**, solo por el `SerialExecutor` en memoria (que M8 anula).
- **Impacto hoy:** acotado, porque mientras un soporte está `SENDING` el carril de entrega solo escribe `PENDING_SEND` (D21) y los uploads están bloqueados. Pero es una fragilidad estructural que M8, A2 y cualquier caso de uso nuevo convierten en pérdida de datos silenciosa.
- **Propuesta:** columna `version` en `receipts` y `batches` con comprobación optimista en `save` (`WHERE version = $n`, `DomainError`/`ConflictError` si 0 filas); `saveManifest` **sin** `DO UPDATE` (una violación de unicidad debe ser un error visible); relectura dentro de `write()` en `RunExecution`.

### M12 — La purga al `COMPLETED` borra los archivos de soportes que no se alcanzaron

**Estado:** corregido en `audita` (D42, commit `a960b8d`).

- **Evidencia:** `run-execution.ts:259-263` pone `fileAvailable=false` a **todos** los soportes del lote, incluidos `PENDING` con error de destinatario (`SOURCE_UNAVAILABLE`, `CONTRACT_NOT_FOUND`…) y los bloqueados por `DUPLICATE_CONFLICT`, que no estaban en el manifiesto.
- **Escenario:** Tayrona falló al cargar 5 de 300; se envían 295; el lote queda `COMPLETED`; Tayrona vuelve; *Refresh recipients* resuelve los 5 → quedan listos **pero sin archivo**: el operador debe volver a subir los 5 PDF y, si no lo nota (el resumen los muestra con el error de destinatario corregido, pero `fileAvailable=false` solo se traduce a `FILE_NOT_AVAILABLE` para `FAILED`, `get-batch-summary.ts:58`), cree que están listos.
- **Propuesta:** purgar solo los soportes **procesados** en esa ejecución (`SENT`, `FAILED` del manifiesto); mostrar `FILE_NOT_AVAILABLE` para cualquier estado sin archivo; o, si se prefiere D4 estricto, documentarlo y hacer que `RefreshRecipients` lo advierta en la respuesta.

### M13 — Sin CORS: el cliente web (repositorio aparte) no podrá hablar con la API desde otro origen

**Estado:** corregido en `audita` (D49, commit `3574f17`).

- **Evidencia:** no hay `enableCors` ni cabecera `Access-Control-*` en `src/` (búsqueda `cors|helmet` sin resultados). D12 exige abrir el SSE con `fetch` + `Authorization: Bearer`, lo que dispara *preflight*.
- **Propuesta:** `CORS_ALLOWED_ORIGINS` en configuración, obligatorio en producción, aplicado en `bootstrap.ts`; o servir el cliente desde el mismo origen y documentarlo en `deploy/`.

### M14 — Alertas sin reconocimiento, sin paginación y con búsqueda O(n)

**Estado:** corregido en `audita` (D46, commit `183cc4b`). La deduplicación ya no compara el texto del detalle: las alertas guardan una referencia (D50, commit `e150ce1`).

- **Evidencia:** `GET /alerts` devuelve todo el historial (`executions.controller.ts:54-57`); no existe "atendida"; `alertOnce` recorre `tx.alerts.list()` completo en cada barrido (`reconciliation.ts:217`).
- **Impacto:** la interfaz no puede distinguir lo pendiente; con retención permanente la lista solo crece. §13 pide "información mínima" útil, no un archivo.
- **Propuesta:** `acknowledged_at`/`acknowledged_by` (auditado), filtro `?pending=true`, consulta por tipo y sujeto en SQL.

### M15 — `StartExecution` encola el trabajo **después** del *commit*

**Estado:** corregido en `audita` (D40, commit `f2b2611`).

- **Evidencia:** `start-execution.ts:82` tras la transacción (líneas 54-79). Si `enqueue` falla (BD intermitente), la ejecución queda `RUNNING` sin trabajo y el operador recibe `500`; la decisión del paso 6 ("si cae entre registrar y encolar, la recuperación lo detiene") solo vale si el **proceso** cae, no si falla la llamada.
- **Propuesta:** `JobQueue.enqueue` acepta la transacción (`tx.jobs.enqueue`) —la tabla ya está en la misma BD—, igual que el *outbox*. Aplica también a `DeliveryFollowUps` (tres `enqueue` no atómicos; duplicados inocuos, pero una caída a mitad deja conciliaciones sin programar y el evento se reintenta solo si el relé lo marca fallido).

---

## 5. Hallazgos de gravedad baja y observaciones

| # | Hallazgo | Evidencia | Propuesta |
|---|---|---|---|
| B1 | Tras `ACCOUNT_ERROR` el soporte vuelve a `PENDING` con `errorDetail: 'LE_102'` y **sin** `errorType`; aparece "listo" con un detalle de error ajeno (**verificado**, H12) | `run-execution.ts:187-194`, `send-outcome.ts:44` | Limpiar `errorDetail` al volver a `PENDING`, o anotar la causa solo en el historial |
| B2 | Corregir el contrato de un `PENDING` subiendo el archivo con el nombre arreglado ya no es "renombrar" sino `DUPLICATE_CONFLICT` con nota obligatoria (**verificado**, H6). Es consecuencia de D31, pero convierte el error más común del operador en dos pasos | `upload-receipts.ts:125-168` | Decidir si un conflicto en el **mismo lote** con el **mismo operador** en la **misma sesión** puede resolverse en la misma respuesta (p. ej. `?replace=true`), o aceptar la fricción y documentarla para el cliente web |
| B3 | `RemoveReceipt` y `ResolveDuplicateConflict` exigen periodo operable: un `PENDING` o un conflicto de hace tres meses **no se puede retirar ni resolver nunca** | `remove-receipt.ts:19`, `resolve-duplicate-conflict.ts:46-49` | Permitir retirar en cualquier periodo (es una corrección, no un envío) |
| B4 | Controladores que leen el repositorio directamente (`alerts`, `suppressions`, `webhooks/events`) y controlador SSE acoplado a `SseProgressHub` (adaptador de **salida**); la prueba de arquitectura no vigila `adapters/inbound → adapters/outbound` ni `adapters → composition` | `executions.controller.ts:7,55`, `delivery.controller.ts:62`, `webhooks.controller.ts:49,55` | Casos de uso de consulta (`ListAlerts`, `ListSuppressions`, `ListWebhooks`), puerto `ProgressNotifier.subscribe`, regla nueva en `architecture.test.ts` |
| B5 | `SIGN_IN_FAILED` escribe el usuario **tal cual lo envió el atacante** como `actor` en la tabla inmutable, desde una ruta pública sin límite de tasa (por diseño "sin bloqueo", §15) | `auth-use-cases.ts:23` | Límite de tasa por IP en el adaptador HTTP (no cambia la regla de negocio); truncar/normalizar el usuario |
| B6 | Fuera de producción, un rebote del **buzón de prueba** suprime localmente la dirección **real** del contrato (`attempt.to`) | `apply-delivery-event.ts:124-128` con `RedirectingEmailProvider` | Con `NONPROD_REDIRECT_TO`, no alimentar la lista local |
| B7 | No hay registros de operación: solo errores de trabajos. Ningún envío, webhook, conciliación ni comando deja traza en el log (está en el paso 12, pero sin ellos ninguno de los hallazgos anteriores se diagnostica en el piloto) | búsqueda `Logger` en `src/` | Log estructurado por caso de uso (sin contenido de PDF ni correos completos) |
| B8 | `GET /health` no comprueba BD ni volumen | `health.controller.ts` | `SELECT 1` y `access(DATA_DIR)` |
| B9 | `jobs` (DONE/FAILED), `outbox_events` despachados y `execution_events` crecen sin límite | esquema | Limpieza periódica de lo despachado con más de N días (la auditoría y los soportes son permanentes; estas tablas no son registro de negocio) |
| B10 | Un PDF de 15 MB se envía en base64 (~20 MB) y ZeptoMail limita el **mensaje** (supuesto por validar); se rechazaría como `SM_127` tras aceptar la carga | `zeptomail-email-provider.ts:body()` | Bajar el tope de carga a lo que admita el cuerpo codificado, o validar con la cuenta real |
| B11 | `SweepUnconfirmed` carga **todos** los `SENT` del historial permanente cada hora | `reconciliation.ts:180` | Consulta por ventana de tiempo en el puerto (`listSentUnconfirmedBetween`) |
| B12 | `latestAttempt` ordena por `started_at, attempt_id`; dos intentos en el mismo milisegundo (reloj fijo en pruebas, posible en producción con reenvío inmediato) pueden invertirse | `postgres-bulk-mailer-repository.ts:listByReceipt` | Ordenar por `seq` (añadir `bigserial` a `attempts`) |

**Estado de §5:** corregidos en `audita` (D50): B1 y B6 (commit `078ccbc`), B3, B5, B7 y B8 (commit `722b330`), B4 (commit `612ae1e`), B9, B10, B11 y B12 (commit `e150ce1`). **B2 queda abierto** como decisión de producto (pregunta al usuario en D50).

**Observaciones sin acción propuesta (para que consten):**
- `ResendReceipt` no exige periodo operable (documentado) ni comprueba que el lote del soporte no esté `RUNNING` por **otra** ejecución: no hace falta, el bloqueo es global.
- `eventRecipientRole` trata un evento **sin destinatario** como del principal si el correo no llevó copia (supuesto declarado en el paso 9); si ZeptoMail omite el destinatario en *Delivered*, funciona; si lo omite en *bounce* de la copia cuando sí hubo copia, queda `UNKNOWN` y no toca el soporte (correcto).
- La firma del webhook no cubre `ts` (así lo documenta Zoho): la ventana de 300 s permite repetición exacta del mismo cuerpo, neutralizada por `webhook_request_id`/SHA-256 del cuerpo. Correcto.
- Las pruebas no cubren: excepción no clasificada dentro del lote (A2), dos instancias (M8), apagado durante el lote (M9), evidencia tardía sobre `FAILED` (A1), barrido con `SOFT_BOUNCE` (M3), *outbox* con más de 50 envenenados (M7). Las 459 pruebas prueban lo que el diseño previó; los hallazgos están donde no previó.

---

## 6. Supuestos que siguen sin validar (no son fallas; condicionan la gravedad de varios hallazgos)

| Supuesto (paso 9 / §12.7) | Hallazgo al que afecta | Si el supuesto es falso… |
|---|---|---|
| Demora de aparición en los logs ≤ 60 min | **A1** | …cada `UNCERTAIN` se marcará fallido y se reenviará: duplicados sistemáticos |
| Forma del campo `to` en `GET /v1.1/email` | **A4** | …todos los `UNCERTAIN` acaban `NOT_FOUND_AT_PROVIDER` |
| Límites de uso de la API de logs; cuota compartida con el envío | **A5** | …el seguimiento por minuto detiene los lotes |
| JSON real de los webhooks (`client_reference`, `object`, destinatario) | **M6**, M4 | …los webhooks llegan y no cambian nada, y la alerta culpa al *endpoint* |
| Política de reintentos de webhooks de Zoho | M3, M6 | …un 500 nuestro (p. ej. A2 con BD caída) pierde el evento para siempre |
| Respuesta a dirección suprimida (silencio o error) | M3 | …el `SOFT_BOUNCE` sin barrido se vuelve "entregado" sin serlo |
| `Authorization: Bearer` y cuerpo `{contrato, activo, nombre_conjunto, correo}` en Tayrona/SAP | A3 (duración del bloqueo) | …`SOURCE_UNAVAILABLE` masivo en la primera carga: 5 s × contratos con el ejecutor tomado |

---

## 7. Evidencia empírica

Pruebas de borrador escritas con los *fixtures* en memoria de `test/support/`, ejecutadas sobre `main` (`c0c3fd2`) y descartadas después. Salida literal (`console.log`) de cada escenario:

```
H1  late webhook for a FAILED/NOT_FOUND_AT_PROVIDER receipt
    { results: ['RECORDED'], state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER',
      lastHistory: 'DELIVERY_EVENT_IGNORED', alerts: [] }

H2  exception inside the execution job (fileStore.read throws EIO)
    { stillRunning: true, uploadError: 'EXECUTION_IN_PROGRESS', startError: 'EXECUTION_IN_PROGRESS',
      states: ['SENDING', 'PENDING'], nextJob: undefined }

H3  resend left UNCERTAIN, then FAILED by reconciliation
    { batchState: 'OPEN', startError: 'NOTHING_TO_SEND', reupload: 'DUPLICATE',
      ready: 0, needsCorrection: ['NOT_FOUND_AT_PROVIDER'] }   → only Refresh recipients unblocks it

H4  STOPPED batch (3 uncertain in a row) whose receipts the logs confirm as delivered
    { batchState: 'STOPPED', states: ['SENT/ACCEPTED/file=true' ×3], filesOnVolume: 3,
      startError: 'NOTHING_TO_SEND' }

H6  PENDING receipt re-uploaded with a corrected contract
    ['DUPLICATE_CONFLICT/']

H8  SOFT_BOUNCE 10 h old, logs say HARD_BOUNCE, sweep
    { lookedUp: 0, updated: 0, alerts: 0 } lookupCalls 0

H9  one UNCERTAIN send, NOT_FOUND, FAILED; sweep 10 h later
    { lookedUp: 0, updated: 0, alerts: 1 }
    ['WEBHOOKS_NOT_RECEIVED: 1 receipt(s) sent by 2026-10/CASH and no webhook in 6 h. …']

H11 final lookup with the logs API unavailable, 100 h later
    { state: 'UNCERTAIN', sweep: { lookedUp: 0, updated: 0, alerts: 0 }, pendingJob: undefined, alerts: [] }

H12 ACCOUNT_ERROR (LE_102)
    { state: 'PENDING', errorType: undefined, errorDetail: 'LE_102', attempts: 1 }
```

---

## 8. Lo que sí resiste el escrutinio

Para que el informe no se lea como si todo estuviera mal: se intentó romper y **no se pudo** en estos puntos.

- **Idempotencia del envío:** intento registrado antes de llamar al proveedor, `client_reference = attemptId`, UNIQUE en `attempt_id`, `sha256`, `webhook_request_id`, `event_id`; un `SENT` nunca vuelve a entrar en una ejecución (`readyManifestEntries`).
- **Máquinas de estado** aplicadas con `assertTransition`/`assertBatchTransition` en cada escritura; la entrega solo avanza; anomalías registradas.
- ***Outbox*:** eventos en la misma transacción que los cambios; relé *at-least-once*; consumidores idempotentes (trabajo duplicado inocuo, eventos deduplicados por id).
- **Autenticación:** HS256 con cabecera fija (rechaza `none`), *refresh* de un solo uso con rotación atómica, sesión absoluta, cierre inmediato (la sesión se consulta en cada verificación), Argon2id, cuentas no administrables por la app (`roles.sql`), auditoría inmutable por *trigger* y por permisos.
- **Webhook:** cabecera secreta comparada en tiempo constante, HMAC sobre el valor decodificado, ventana de `ts`, cuerpo crudo guardado siempre, `200` inmediato, procesamiento asíncrono, dedup por id o SHA-256 del cuerpo.
- **Separación de capas:** `architecture.test.ts` impide que dominio/puertos/aplicación importen infraestructura; `app.module.ts` es el único punto de composición; los adaptadores de ZeptoMail y Tayrona "nunca lanzan" y traducen a tipos neutrales (P1).
- **Configuración:** falla al arrancar con la lista completa de problemas; simulados prohibidos en producción; TLS obligatorio; `NONPROD_REDIRECT_TO` obligatorio fuera de producción con ZeptoMail.

---

## 9. Orden de atención sugerido (sin implementar nada hasta aprobación)

1. **A2 + M9** (robustez del carril de ejecución: excepciones y apagado). Son los que van a ocurrir seguro en el piloto y dejan el sistema inoperable.
2. **A1 + A4** (no convertir incertidumbre en "no enviado" sin pruebas; aceptar evidencia tardía). Protegen la garantía principal mientras se calibra `RECONCILE_DELAYS_MINUTES`.
3. **A3 + M11** (sacar las llamadas externas del ejecutor; versión optimista). Hacen cumplir D21 y sostienen todo lo demás.
4. **A5 + M7 + M15** (trabajos: dedup, prioridad, *outbox* sin cabeza bloqueada, encolado transaccional).
5. **M1 + M12** (retención de PDF).
6. **M2, M3, M4, M6, M14** (alertas que digan la verdad y cubran los huecos).
7. **M8, M10, M13** (despliegue: una instancia, memoria, CORS).
8. Bajos y observaciones según convenga.

Cada punto se puede registrar como decisión (D32 en adelante) **solo después** de que el usuario lo apruebe, paso a paso, como manda la regla 2. Ninguno exige las APIs reales ni la cuenta de ZeptoMail; A4, A5 y M6 se **completan** con el paso 12, pero su parte de código puede corregirse antes.

**Estado al cierre:** bloques 1–8 aplicados en `audita` (D32–D50), pendientes de fusión a `main`. Quedan como preguntas al usuario: la retención máxima de PDF de soportes que siguen "necesarios", el reconocimiento automático de alertas y B2.
