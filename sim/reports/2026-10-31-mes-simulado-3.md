# Tercer mes simulado (2026-10-31): `main` auditado (D32–D53) en la rama `simulacion`

Corrida de 21:31 a 22:48 UTC (76,4 min) contra el código de `main` tras la auditoría (commit `6951bc3` fusionado en `simulacion`), con los escenarios nuevos de S7. El informe automático del guion está más abajo, sin editar. Esta cabecera lo analiza y lo compara con los dos meses anteriores (`2026-10-31-mes-simulado.md`: 8 diferencias; `2026-10-31-mes-simulado-2.md`: 0 diferencias).

## Veredicto

- **Los 300 soportes del mes se comportaron igual que en el segundo mes**: 43/42/43/43/41/43 listos por lote, los mismos estados finales, ~12 min por lote, 76 min en total (73 en el segundo mes; los 3 min extra son los escenarios nuevos: aborto, apagado y reinicio, dos instancias).
- **Los escenarios de la auditoría pasaron de punta a punta**: 413 por presupuesto (D48), aborto con `force` y asentamiento `STOPPED → COMPLETED` con retiro de archivos (D32, D41), evidencia tardía `FAILED → SENT` sin reenvío (D34), webhook ilegible alertado una sola vez (D45), alertas resueltas frente a reconocidas (D46, D52), apagado con SIGTERM y segunda ejecución (D33), webhook perdido hallado por el barrido de 1 h (D44), segunda instancia `standby` (D47), liberación manual de archivos (D51), retiro de archivos al completar cada lote (D41), `/health`, `outbox` sin eventos muertos ni trabajos fallidos.
- **El guion listó 11 diferencias. Ninguna es un defecto funcional de `main`.** Nueve eran expectativas del guion vencidas o equivocadas (ya corregidas en la rama, S8 y S11); una es un defecto de la propia rama (S10, corregido); una es una observación menor sobre `main` que se propone como decisión (D55). Además, al analizar el apagado apareció un defecto menor de `main` en los contadores de una ejecución recuperada (propuesta D54).

## Las 11 diferencias, una por una

| # | Diferencia | Causa | Qué se hizo |
|---|---|---|---|
| 1–6 | En cada lote, el escenario `processfailed` terminó `SENT / PROCESS_FAILED` con alerta `PROCESS_FAILED`, no `UNCONFIRMED` con nota en el historial | **Expectativa vencida**: D29 (decidida en esta rama) se implementó en `main` a las 16:32, después del segundo mes (16:13). El comportamiento nuevo es el decidido | Expectativa actualizada en `sim/generate.ts` (S8) |
| 7 | Tras el aborto, `GET /executions/current` respondió 200 con la ejecución terminada, no 404 | **Expectativa equivocada del guion**: D10 dice "la ejecución en curso o la última" | Comprobación corregida en `sim/run.ts` (S11) |
| 8 | `release-files`: el resumen marcó `fileError` en 5 soportes, no en los 3 `PENDING` | **Expectativa equivocada**: el resumen marca `PENDING` y `FAILED` sin archivo (D51), y así debe ser para que el operador vea que no puede reenviar | Comprobación corregida (S11) |
| 9 | Una alerta `WEBHOOKS_NOT_RECEIVED` al final del mes | **Alarma verdadera, no falsa**: es el soporte `nowebhook` del lote 1 (`Conjunto Almendros 100007`), cuya entrega se halló en los logs y nunca por webhook; el barrido lo juzga 1 h después (D44). Solo el lote 1 cumplió la hora dentro del mes | Comprobación corregida: espera exactamente esa alerta (S11) |
| 10 | `outbox` con 1 evento sin despachar al cierre | **Carrera de la comprobación**: el relé lo despachó segundos después (0 pendientes al revisar) | La comprobación espera hasta 15 s (S11) |
| 11 | El lote `OTHERS` quedó `OPEN`, no `COMPLETED`, tras `release-files` | **Observación sobre `main`**: `publishNextManifest` pone el lote en `OPEN` siempre que publica un manifiesto, también cuando solo se liberan archivos de un lote ya completado. Nada se rompe, pero el estado deja de reflejar que el lote terminó | Se propone D55 (abajo). No se toca `main` desde esta rama |

Además, no en la lista pero visible en el lote 4: la ejecución interrumpida quedó con `0 procesados` aunque había procesado 6 soportes.

- **Causa en la rama (S10, corregido):** la espera de entrega entre envíos (S3, solo de esta rama) no atendía la señal de apagado; el proceso viejo no terminó en los 25 s (`Job runner: the job in progress did not finish within 25000 ms of the shutdown`) y la ejecución la cerró la **recuperación tras caída** de la instancia nueva. El resultado fue el correcto (`STOPPED / INTERRUPTED`, nada en `SENDING`, 0 `UNCERTAIN`, los 38 restantes enviados por la segunda ejecución), pero por el camino de la recuperación, no por el apagado cooperativo de D33. Con S10 la espera termina con la señal.
- **Causa en `main` (propuesta D54):** `lastCounters` (`interrupt-execution.ts`), que usa la recuperación tras caída, lee solo el **último** evento de progreso. Si ese evento no trae contadores (`WAITING` por incidente del proveedor en `main`; `WAITING_DELIVERY`/`DELIVERY_RESOLVED` en esta rama), el `FINISHED` queda con `total 0, processed 0` y `GET /executions/{id}` lo muestra así para siempre. Corrección propuesta: buscar hacia atrás el último evento con contadores, como ya hace `GetExecution`.

## Propuestas para `main` (pendientes de aprobación del usuario)

- **D54 — Contadores de una ejecución recuperada.** `lastCounters` toma el último evento **con contadores** (`STARTED`, `RECEIPT_PROCESSED`, `FINISHED`), no el último evento. Prueba unitaria: ejecución con `WAITING` como último evento antes de la caída conserva `processed`.
- **D55 — `release-files` no reabre el lote.** Publicar la versión nueva del manifiesto al liberar archivos (D51) no debe cambiar el estado de un lote `COMPLETED` (ni `STOPPED`). Alternativa: aceptar `OPEN` y documentarlo; en ese caso el cliente web debe saber que `OPEN` con 0 listos tras una liberación no es un lote por enviar.

## Lo que este mes no pudo provocar

- Excepción inesperada dentro de la ejecución (`INTERNAL_ERROR`, D32): no se puede provocar desde fuera sin inyectar una falla; cubierto por pruebas unitarias. El camino del operador (`abort`) sí se ejercitó.
- Rebote duro con webhook perdido hallado por el barrido (D44): se perdió a propósito un `delivered`, no un rebote; el camino por los logs es el mismo.
- Evento muerto del *outbox* y su reintento (D39): el bus no falló durante el mes.
- El apagado cooperativo de D33 **con la espera de entrega atendiendo la señal** (S10) queda por comprobar en la siguiente corrida.

## Comparación con los meses anteriores

| | Mes 1 | Mes 2 | Mes 3 (este) |
|---|---|---|---|
| Código | `130a30f` + S1–S5 | ídem + correcciones de la simulación | `main` auditado (D32–D53) |
| Duración | — | 72,8 min | 76,4 min |
| Diferencias del guion | 8 | 0 | 11 (9 expectativas, 1 de la rama, 1 observación) |
| Defectos hallados en `main` | 8 corregidos en `main` | 0 | 0 funcionales; 2 menores propuestos (D54, D55) |
| Escenarios de la auditoría | — | — | 10 de 12 de punta a punta; 2 no provocables |

---

# Simulación de un mes: 2026-10

Inicio: 2026-10-31T21:31:53.007Z. App en modo producción contra simuladores de Tayrona, SAP y ZeptoMail (Docker), código de `main` tras la auditoría (D32–D53).
Configuración: pausa entre envíos 1 s, espera de entrega hasta 120 s (consulta de logs cada 30 s), conciliación a 1/2/3 min, seguimiento 3 min después del lote, barrido de envíos de más de 1 h cada 5 min, cierre a más tardar 300 s después del envío, UPLOAD_MAX_FILES=50.

## Lote 1/6: CASH (día 7 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ conflicto de duplicado (D31) `Conjunto Altos 100021 cash 21 CNCPT MULTA CNTRT 100021.pdf` resuelto con el nombre original `Conjunto Ceibas 100019 cash 19 CNCPT MULTA CNTRT 100019.pdf`: HTTP 200

- Ejecución `b014c600-8b75-4bda-a1d4-d49457607348`: **COMPLETED**, 43 procesados en 467.5 s
- Lote: estado **COMPLETED**, versión de manifiesto 2, copia bcc: no
- Carga: 50 archivos en 0.4 s → registrados 49, conflictos de duplicado resueltos 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **467.5 s** (10.9 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.9 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301.2 s después del envío; quedaron pendientes de entrega 2
- Archivos (D41): 3 conservados (PENDING ×3), 46 retirados; en el volumen quedan 3
- **Duración total del lote: 12.8 min** (769.2 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 36 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / PROCESS_FAILED | 1 |
| INVALID / NOT_A_PDF | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| INVALID / INVALID_NAME | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| SENT / COMPLAINT | 1 |
| SENT / SOFT_BOUNCE | 1 |
| SENT / UNCONFIRMED | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |

Éxito (SENT entregado o con queja/rebote informado): 42 enviados de 43 listos; entregados (ACCEPTED) 36.

**Alertas del lote** (4): HARD_BOUNCE ×2, COMPLAINT ×1, PROCESS_FAILED ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Palmas 100026 cash 26 CNCPT PAGO ADMINISTRACIÓN CNTRT 100026.pdf | processfailed | carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED | carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED | §9.4: process failed after acceptance; no SENT → FAILED transition |

## Reenvío y liberación (después del lote 1)

Soporte: `Conjunto Ceibas 100014 cash 14 CNCPT MULTA CNTRT 100014.pdf` → conjunto100014+zm-hardbounce@clientes.test

- ✅ volver a subir el PDF (A2): {"fileName":"Conjunto Ceibas 100014 cash 14 CNCPT MULTA CNTRT 100014.pdf","outcome":"REGISTERED","sha256":"c08fc70f553e26af351e33fef305b20a6d1d98c68ccf27a2f7156cd55b22bb93","state":"SENT"}
- ✅ reenvío con la dirección suprimida → 409 EMAIL_SUPPRESSED: HTTP 409 {"error":"EMAIL_SUPPRESSED"}
- ✅ liberar la dirección (D19): HTTP 200 {"email":"conjunto100014+zm-hardbounce@clientes.test","provider":"CONFIRMED_BY_OPERATOR"}
- ✅ reenviar: HTTP 200 {"attemptId":"0d77480a-6f3a-44db-bd5d-d8df39aa7511","state":"SENT","previousEmail":"conjunto100014+zm-hardbounce@clientes.test","email":"conjunto100014+zm-hardbounce@clientes.test"}
- ✅ el reenvío vuelve a rebotar (la dirección simulada siempre rebota) y queda suprimida: SENT / HARD_BOUNCE, suprimida: true

## Aborto del operador y asentamiento del lote (D32, D41), después del lote 1

Soporte extra `Conjunto Ceibas 100251 cash extra CNCPT CUOTA EXTRA CNTRT 100251.pdf` → conjunto100251+zm-timeout@clientes.test (el simulador tarda 60 s en responder; la app corta a los 30 s).

- ℹ️ lote CASH antes: OPEN
- ✅ subir un soporte nuevo al lote completado (vuelve a OPEN): {"fileName":"Conjunto Ceibas 100251 cash extra CNCPT CUOTA EXTRA CNTRT 100251.pdf","outcome":"REGISTERED","sha256":"3818f2806c900880d3d94f441cd970ff4341568082f34adc9e8f74906b34a983","state":"PENDING"}
- ✅ el lote reabre con un solo soporte listo: estado OPEN, listos 1
- ✅ ejecución iniciada (202): HTTP 202 {"executionId":"c7863ce6-45c7-4d86-a431-f82dcf1c8c0c"}
- ✅ el soporte está SENDING (la llamada al proveedor está en curso): SENDING
- ✅ abort sin `force` con progreso reciente → 409: HTTP 409 {"error":"EXECUTION_STILL_ACTIVE","lastActivityAt":"2026-10-31T21:44:48.788Z","abortableAt":"2026-10-31T21:54:48.788Z"}
- ✅ abort con `force` → 200, STOPPED / INTERRUPTED, un soporte UNCERTAIN: HTTP 200 {"executionId":"c7863ce6-45c7-4d86-a431-f82dcf1c8c0c","result":"STOPPED","stopReason":"INTERRUPTED","uncertain":["3818f2806c900880d3d94f441cd970ff4341568082f34adc9e8f74906b34a983"]}
- ✅ GET /executions/{id} lo muestra terminado STOPPED / INTERRUPTED: STOPPED / INTERRUPTED
- ✅ el soporte quedó UNCERTAIN (liberado): UNCERTAIN
- ✅ el lote quedó STOPPED: STOPPED / INTERRUPTED
- ❌ ninguna ejecución en curso (el cerrojo global se liberó): GET /executions/current → 404 NO_EXECUTION: HTTP 200 {"executionId":"c7863ce6-45c7-4d86-a431-f82dcf1c8c0c","period":"2026-10","block":"CASH","manifestVersion":4,"startedBy":"operador","startedAt":"2026-10-31T21:44:48.469Z","finishedAt":"2026-10-31T21:44:53.495Z","result":"STOPPED","stopReason":"INTERRUPTED","batchState":"STOPPED","counters":{"total":1,"byState":{},"processed":0,"byErrorType":{}},"lastEventSeq":130}
- ✅ la conciliación encuentra el envío: SENT / ACCEPTED: SENT / ACCEPTED
- ✅ el lote STOPPED sin nada pendiente se asienta a COMPLETED: COMPLETED / —
- ✅ el archivo del soporte se retiró del volumen (DELETE_RECEIPT_FILE): disponible=false, en volumen=false
- ✅ ningún soporte procesado del lote conserva archivo: 0 con archivo
- ℹ️ trabajos de archivos del lote: DELETE_RECEIPT_FILE DONE ×4, PURGE_BATCH_FILES DONE ×1
- ✅ la alerta BATCH_STOPPED quedó resuelta por el sistema (resolvedAt): [{"subject":"c7863ce6-45c7-4d86-a431-f82dcf1c8c0c","resolvedAt":"2026-10-31T21:45:49.659Z","resolution":"batch settled: nothing left to send or to resolve"}]
- ℹ️ historial del soporte: UPLOADED → SENDING → UNCERTAIN → OUTCOME_NOT_APPLIED → SENT → DELIVERY_ACCEPTED

## Presupuesto de carga (D48), antes del lote 2

Se envían los 50 archivos del lote más uno extra (`Conjunto Ceibas 100252 avvillas extra CNCPT PAGO ADMINISTRACIÓN CNTRT 100252.pdf`) en la misma petición; luego el lote se carga normalmente con sus 50.

- ✅ 51 archivos en una sola petición con UPLOAD_MAX_FILES=50 → 413 UPLOAD_TOO_LARGE: HTTP 413 {"error":"UPLOAD_TOO_LARGE","maxTotalBytes":209715200,"maxFiles":50}
- ✅ nada quedó registrado en el lote: 0 soportes en AVVILLAS
- ✅ no quedan archivos en .staging del volumen: 0 entradas
- ✅ la app sigue sana después del 413: GET /health → 200

## Lote 2/6: AVVILLAS (día 12 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ conflicto de duplicado (D31) `Conjunto Cedros 100100 avvillas 50 CNCPT CUOTA EXTRA CNTRT 100100.pdf` resuelto con el nombre original `Conjunto Laureles 100099 avvillas 49 CNCPT CUOTA EXTRA CNTRT 100099.pdf`: HTTP 200

- Ejecución `402f44f8-b1e5-4175-9dde-67d25d1f9afc`: **COMPLETED**, 42 procesados en 417.4 s
- Lote: estado **COMPLETED**, versión de manifiesto 2, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, conflictos de duplicado resueltos 1; listos para enviar 42, por corregir 7
- Envío: 42 procesados en **417.4 s** (9.9 s por soporte)
- Espera de entrega: 40 esperas, promedio 8.6 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301.1 s después del envío; quedaron pendientes de entrega 2
- Archivos (D41): 4 conservados (PENDING ×4), 45 retirados; en el volumen quedan 4
- **Duración total del lote: 12 min** (718.8 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 34 |
| SENT / HARD_BOUNCE | 2 |
| PENDING / SOURCE_UNAVAILABLE | 1 |
| SENT / UNCONFIRMED | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |
| SENT / PROCESS_FAILED | 1 |
| SENT / SOFT_BOUNCE | 1 |
| SENT / COMPLAINT | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| FAILED / PROVIDER_REJECTED | 1 |

Éxito (SENT entregado o con queja/rebote informado): 40 enviados de 42 listos; entregados (ACCEPTED) 34.

**Alertas del lote** (4): HARD_BOUNCE ×2, PROCESS_FAILED ×1, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Almendros 100069 avvillas 19 CNCPT CUOTA EXTRA CNTRT 100069.pdf | processfailed | carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED | carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED | §9.4: process failed after acceptance; no SENT → FAILED transition |

## Evidencia tardía de un envío dado por no encontrado (D34), después del lote 2

Soporte `Conjunto Almendros 100076 avvillas 26 CNCPT MULTA CNTRT 100076.pdf` → conjunto100076+zm-503@clientes.test: el simulador respondió 503 y nunca aceptó el correo; el guion firma un webhook `email_delivered` con el `client_reference` del intento, como si ZeptoMail lo hubiera aceptado después de todo.

- ✅ el soporte 503 terminó FAILED / NOT_FOUND_AT_PROVIDER al cierre del lote: FAILED / NOT_FOUND_AT_PROVIDER
- ℹ️ intentos antes: BATCH UNCERTAIN
- ✅ webhook `email_delivered` firmado para ese intento → 200: HTTP 200 {}
- ✅ FAILED → SENT / ACCEPTED (única transición permitida desde FAILED): SENT / ACCEPTED / error ninguno
- ✅ alerta LATE_SEND_EVIDENCE pendiente: [{"detail":"Conjunto Almendros 100076 avvillas 26 CNCPT MULTA CNTRT 100076.pdf: attempt 45a87afd-5bdc-4540-a7fc-5b3820d6b75a to conjunto100076+zm-503@clientes.test, marked FAILED / NOT_FOUND_AT_PROVIDER at 2026-10-31T21:49:47.295Z, did go out: ACCEPTED from the delivery webhook. It is SENT now; if it was sent again meanwhile, the client received it twice."}]
- ✅ sin alerta DUPLICATE_SEND_DETECTED (no hubo segundo envío): 0 alertas
- ✅ ningún intento nuevo: 1 intentos
- ✅ historial con SENT confirmado tarde: UPLOADED → SENDING (attempt 45a87afd-5bdc-4540-a7fc-5b3820d6b75a) → UNCERTAIN (HTTP 503) → FAILED (NOT_FOUND_AT_PROVIDER (reconciliation of attempt 45a87afd-5bdc-4540-a7fc-5b3820d6b75a)) → SENT (SENT confirmed late by delivery webhook (attempt 45a87afd-5bdc-4540-a7fc-5b3820d6b75a)) → DELIVERY_ACCEPTED
- ✅ el archivo quedó retirado: disponible=false, en volumen=false
- ℹ️ lote AVVILLAS: COMPLETED

## Webhook ilegible (D45), después del lote 2

- ✅ webhook firmado con una forma desconocida → 200 (se acepta y se guarda): HTTP 200 {}
- ✅ alerta WEBHOOK_UNPARSED con el webhook_request_id como sujeto: ["Webhook sim-unparsed-7e556605d5824e69b20546cdb0263c12: no delivery event could be read; dropped: [0] no email_info.client_reference; event names seen: something_new. Check the payload at GET /webhooks/zeptomail/events/sim-unparsed-7e556605d5824e69b20546cdb0263c12 and the parser assumptions (§12.7)."]
- ✅ el payload se puede consultar en GET /webhooks/zeptomail/events/{id}: HTTP 200
- ✅ el mismo webhook repetido no duplica la alerta: HTTP 200, 1 alertas
- ✅ un webhook sin autenticación se rechaza: HTTP 401

## Lote 3/6: BANCOLOMBIA (día 18 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ agregar concepto SANCIÓN: HTTP 201 {"key":"SANCIÓN","subject":"Sanción","active":true}
- ✅ conflicto de duplicado (D31) `Conjunto Cedros 100111 bancolombia 11 CNCPT CUOTA EXTRA CNTRT 100111.pdf` resuelto con el nombre original `Conjunto Pinos 100109 bancolombia 09 CNCPT PAGO ADMINISTRACIÓN CNTRT 100109.pdf`: HTTP 200

- Ejecución `55617b70-f82f-4a77-85d6-74daeb1ce976`: **COMPLETED**, 43 procesados en 461.6 s
- Lote: estado **COMPLETED**, versión de manifiesto 2, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, conflictos de duplicado resueltos 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **461.6 s** (10.7 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.7 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301 s después del envío; quedaron pendientes de entrega 2
- Archivos (D41): 3 conservados (PENDING ×3), 46 retirados; en el volumen quedan 3
- **Duración total del lote: 12.7 min** (762.9 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 36 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| INVALID / INVALID_NAME | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| SENT / COMPLAINT | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| INVALID / NOT_A_PDF | 1 |
| SENT / SOFT_BOUNCE | 1 |
| SENT / UNCONFIRMED | 1 |
| SENT / PROCESS_FAILED | 1 |

Éxito (SENT entregado o con queja/rebote informado): 42 enviados de 43 listos; entregados (ACCEPTED) 36.

**Alertas del lote** (4): HARD_BOUNCE ×2, PROCESS_FAILED ×1, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Almendros 100142 bancolombia 42 CNCPT CUOTA EXTRA CNTRT 100142.pdf | processfailed | carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED | carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED | §9.4: process failed after acceptance; no SENT → FAILED transition |

## Alertas: resueltas por el sistema y reconocidas por el operador (D46, D52), después del lote 3

- ✅ GET /alerts?pending=true&resolved=false responde la vista por defecto del cliente: 14 alertas: HARD_BOUNCE ×6, COMPLAINT ×3, PROCESS_FAILED ×3, WEBHOOK_UNPARSED ×1, LATE_SEND_EVIDENCE ×1
- ✅ reconocer LATE_SEND_EVIDENCE → 200 con acknowledgedAt/By: HTTP 200 {"acknowledgedAt":"2026-10-31T22:10:39.398Z","acknowledgedBy":"operador"}
- ✅ reconocerla de nuevo no es un error silencioso: HTTP 409 {"error":"ALERT_ALREADY_ACKNOWLEDGED"}
- ✅ ya no aparece entre las pendientes: 13 pendientes
- ✅ sigue existiendo, reconocida, sin resolvedAt (el reconocimiento es del operador, no una resolución): {"acknowledgedAt":"2026-10-31T22:10:39.398Z"}
- ✅ las resueltas por el sistema traen resolvedAt y resolution: 2 resueltas: BATCH_STOPPED ×1, HARD_BOUNCE ×1
- ✅ ninguna resuelta aparece en la vista por defecto: 0 resueltas entre las pendientes
- ℹ️ HARD_BOUNCE sin resolver: 6 (se resuelven al liberar la dirección, D19/D52)
- ✅ más recientes primero: orden descendente por raisedAt

## Apagado durante el lote 4 (D33)

La app recibe SIGTERM (`docker compose stop`, periodo de gracia 40 s) con 5 soportes procesados; mientras está caída se pierde un webhook del lote 1 (lo debe hallar el barrido, D44). Luego arranca de nuevo y el operador lanza una segunda ejecución.

- ✅ `docker compose stop app` (SIGTERM) con 6 procesados: terminó en 26 s, código 0
- ✅ la app no responde mientras está detenida: GET /health → sin conexión
- ✅ el simulador entrega el rebote blando de `Conjunto Ceibas 100020 cash 20 CNCPT MULTA CNTRT 100020.pdf` (lote 1) y su webhook se pierde: estado en el simulador delivered, respuesta del webhook "ENOTFOUND"
- ✅ `docker compose start app` y /health vuelve a 200: en 5 s, código 0, health 200
- ✅ la instancia nueva toma el lease (leader): HTTP 200 {"instanceId":"ba833ec7f067:1:87d2dcc9","role":"leader","leaseHolder":"ba833ec7f067:1:87d2dcc9","leaseExpiresAt":"2026-10-31T22:12:01.502Z"}
- ✅ la ejecución quedó STOPPED / INTERRUPTED: STOPPED / INTERRUPTED
- ✅ ningún soporte quedó SENDING: 0 en SENDING
- ℹ️ soportes UNCERTAIN tras el apagado: 0 (el apagado cooperativo deja terminar el envío en curso)
- ✅ el lote quedó STOPPED con soportes listos para una nueva ejecución: estado STOPPED, listos 38
- ✅ segunda ejecución aceptada (202) con el mismo manifiesto: HTTP 202 {"executionId":"090d9cdc-9bac-4900-a702-7970802c23a6"}

## Lote 4/6: DAVIVIENDA (día 23 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ cambiar el asunto de MULTA a «Multa por convivencia»: HTTP 200 {"key":"MULTA","subject":"Multa por convivencia","active":true}
- ✅ activar la copia bcc: HTTP 200 {"enabled":true,"address":"archivo@anutibara.com"}
- ✅ conflicto de duplicado (D31) `Conjunto Laureles 100198 davivienda 48 CNCPT MULTA CNTRT 100198.pdf` resuelto con el nombre original `Conjunto Robles 100196 davivienda 46 CNCPT PAGO ADMINISTRACIÓN CNTRT 100196.pdf`: HTTP 200

- Ejecución 1 `f03b7b04-d04e-4206-b4c3-f7ffd11d983e`: **STOPPED / INTERRUPTED**, 0 procesados en 51.7 s
- Ejecución 2 `090d9cdc-9bac-4900-a702-7970802c23a6`: **COMPLETED**, 38 procesados en 386.4 s
- Lote: estado **COMPLETED**, versión de manifiesto 2, copia bcc: archivo@anutibara.com
- Carga: 50 archivos en 0.3 s → registrados 49, conflictos de duplicado resueltos 1; listos para enviar 43, por corregir 6
- Envío: 38 procesados en **438.1 s** (11.5 s por soporte)
- Espera de entrega: 40 esperas, promedio 8.3 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 302 s después del envío; quedaron pendientes de entrega 2
- Archivos (D41): 3 conservados (PENDING ×3), 46 retirados; en el volumen quedan 3
- **Duración total del lote: 12.4 min** (744.1 s)
- ✅ Asunto de un correo de MULTA en ZeptoMail: «Multa por convivencia – Octubre 2026»

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 35 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / NOT_A_PDF | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| INVALID / INVALID_NAME | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| SENT / SOFT_BOUNCE | 1 |
| SENT / COMPLAINT | 1 |
| SENT / PROCESS_FAILED | 1 |
| SENT / UNCONFIRMED | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |

Éxito (SENT entregado o con queja/rebote informado): 41 enviados de 43 listos; entregados (ACCEPTED) 35.

**Alertas del lote** (5): HARD_BOUNCE ×2, BATCH_STOPPED ×1, COMPLAINT ×1, PROCESS_FAILED ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Guaduales 100178 davivienda 28 CNCPT MULTA CNTRT 100178.pdf | processfailed | carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED | carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED | §9.4: process failed after acceptance; no SENT → FAILED transition |

## Lote 5/6: ANGLO (día 26 del mes, fuente SAP)

**Administración antes del lote**

- ✅ retirar el concepto SANCIÓN: HTTP 200 {"key":"SANCIÓN","subject":"Sanción","active":false}
- ✅ conflicto de duplicado (D31) `Conjunto Almendros 700050 anglo 50 CNCPT PAGO ADMINISTRACIÓN CNTRT 700050.pdf` resuelto con el nombre original `Conjunto Almendros 700049 anglo 49 CNCPT MULTA CNTRT 700049.pdf`: HTTP 200

- Ejecución `04e0d4e6-de94-41f8-a021-eacf30ef7b35`: **COMPLETED**, 41 procesados en 433.7 s
- Lote: estado **COMPLETED**, versión de manifiesto 2, copia bcc: archivo@anutibara.com
- Carga: 50 archivos en 0.3 s → registrados 49, conflictos de duplicado resueltos 1; listos para enviar 41, por corregir 8
- Envío: 41 procesados en **433.7 s** (10.6 s por soporte)
- Espera de entrega: 39 esperas, promedio 8.6 s, máximo 121 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 300.8 s después del envío; quedaron pendientes de entrega 2
- Archivos (D41): 3 conservados (PENDING ×3), 46 retirados; en el volumen quedan 3
- **Duración total del lote: 12.2 min** (734.9 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 34 |
| INVALID / UNKNOWN_CONCEPT | 3 |
| SENT / HARD_BOUNCE | 2 |
| SENT / PROCESS_FAILED | 1 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| SENT / UNCONFIRMED | 1 |
| SENT / COMPLAINT | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |

Éxito (SENT entregado o con queja/rebote informado): 40 enviados de 41 listos; entregados (ACCEPTED) 34.

**Alertas del lote** (4): HARD_BOUNCE ×2, COMPLAINT ×1, PROCESS_FAILED ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Pinos 700006 anglo 06 CNCPT MULTA CNTRT 700006.pdf | processfailed | carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED | carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED | §9.4: process failed after acceptance; no SENT → FAILED transition |

## Dos instancias (D47), después del lote 5

- ✅ la instancia principal es leader: {"instanceId":"ba833ec7f067:1:87d2dcc9","role":"leader","leaseHolder":"ba833ec7f067:1:87d2dcc9","leaseExpiresAt":"2026-10-31T22:35:41.946Z"}
- ✅ la segunda instancia arranca y responde /health: código 0, health 200
- ✅ la segunda instancia atiende HTTP con JWT (sign-in y GET /instance): HTTP 200
- ✅ la segunda queda standby y señala a la primera como titular del lease: {"instanceId":"0da13475040f:1:164f7755","role":"standby","leaseHolder":"ba833ec7f067:1:87d2dcc9","leaseExpiresAt":"2026-10-31T22:35:41.946Z"}
- ✅ lee el mismo estado (lote ANGLO) que la primera: estado COMPLETED
- ✅ 45 s después (más de un TTL) la primera sigue siendo leader: {"instanceId":"ba833ec7f067:1:87d2dcc9","role":"leader","leaseHolder":"ba833ec7f067:1:87d2dcc9","leaseExpiresAt":"2026-10-31T22:36:31.964Z"}
- ✅ la segunda instancia se retira: código 0

## Lote 6/6: OTHERS (día último del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ desactivar la copia bcc: HTTP 200 {"enabled":false,"address":"archivo@anutibara.com"}
- ✅ conflicto de duplicado (D31) `Conjunto Cedros 100219 others 19 CNCPT MULTA CNTRT 100219.pdf` resuelto con el nombre original `Conjunto Pinos 100216 others 16 CNCPT CUOTA EXTRA CNTRT 100216.pdf`: HTTP 200

- Ejecución `8beb94d0-1f3c-4328-87f1-e34bba80dc83`: **COMPLETED**, 43 procesados en 422.1 s
- Lote: estado **COMPLETED**, versión de manifiesto 2, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, conflictos de duplicado resueltos 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **422.1 s** (9.8 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.5 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 302.3 s después del envío; quedaron pendientes de entrega 2
- Archivos (D41): 3 conservados (PENDING ×3), 46 retirados; en el volumen quedan 3
- **Duración total del lote: 12.1 min** (724.7 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 35 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / INVALID_NAME | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| SENT / PROCESS_FAILED | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / NOT_A_PDF | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / SOFT_BOUNCE | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| SENT / UNCONFIRMED | 1 |
| SENT / COMPLAINT | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |

Éxito (SENT entregado o con queja/rebote informado): 41 enviados de 43 listos; entregados (ACCEPTED) 35.

**Alertas del lote** (5): HARD_BOUNCE ×2, PROCESS_FAILED ×1, COMPLAINT ×1, WEBHOOKS_NOT_RECEIVED ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Almendros 100207 others 07 CNCPT PAGO ADMINISTRACIÓN CNTRT 100207.pdf | processfailed | carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED | carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED | §9.4: process failed after acceptance; no SENT → FAILED transition |

## Liberación manual de archivos conservados (D51), después del lote 6

- ℹ️ soportes con archivo conservado antes: 3 (PENDING / CONTRACT_INACTIVE ×1, PENDING / CONTRACT_WITHOUT_EMAIL ×1, PENDING / CONTRACT_NOT_FOUND ×1)
- ✅ esos archivos están en el volumen: 3 de 3
- ✅ sin nota → 400: HTTP 400 {"error":"INVALID_REQUEST","field":"note"}
- ✅ liberar → 200 con released=3: HTTP 200 {"released":3,"manifestVersion":3}
- ✅ los archivos desaparecen del volumen (trabajo DELETE_RECEIPT_FILE): 0 aún en el volumen
- ✅ los registros se conservan: 49 soportes, por corregir 8
- ❌ el resumen marca fileError FILE_NOT_AVAILABLE en los soportes por corregir, aparte de errorType: 5 marcados: NOT_FOUND_AT_PROVIDER ×1, CONTRACT_INACTIVE ×1, CONTRACT_NOT_FOUND ×1, PROVIDER_REJECTED ×1, CONTRACT_WITHOUT_EMAIL ×1
- ✅ el manifiesto avanzó (versión nueva): 2 → 3
- ℹ️ liberar de nuevo: HTTP 200 {"released":0,"manifestVersion":4}

## Barrido de un webhook perdido (D44), al final del mes

- ℹ️ antes del barrido: SENT / ACCEPTED
- ✅ `Conjunto Ceibas 100020 cash 20 CNCPT MULTA CNTRT 100020.pdf` pasa de SOFT_BOUNCE a ACCEPTED sin webhook: SENT / ACCEPTED
- ✅ la entrega llegó por los logs (source LOGS), no por webhook: WEBHOOK:SOFT_BOUNCE, LOGS:SOFT_BOUNCE, LOGS:ACCEPTED
- ❌ sin falsa alarma de silencio de webhooks (D46): 1 alertas WEBHOOKS_NOT_RECEIVED

## Cierre del mes: salud, outbox, trabajos y sobrantes

- ✅ GET /health → 200 ok (BD y volumen): HTTP 200 {"status":"ok"}
- ✅ GET /outbox/dead: ningún evento muerto: HTTP 200 {"events":[]}
- ❌ outbox sin eventos por despachar: 1 pendientes
- ✅ ningún trabajo FAILED ni CLAIMED: CHECK_RECENT_SENDS DONE ×62, DELETE_RECEIPT_FILE DONE ×251, EXECUTE_BATCH DONE ×8, PROCESS_DELIVERY_EVENT DONE ×331, PURGE_BATCH_FILES DONE ×6, PURGE_ORPHAN_FILES DONE ×6, RECONCILE_ATTEMPT DONE ×21, SWEEP_UNCONFIRMED DONE ×14
- ✅ ningún soporte SENDING ni UNCERTAIN al final del mes: ninguno
- ❌ los seis lotes terminaron COMPLETED: ANGLO COMPLETED, AVVILLAS COMPLETED, BANCOLOMBIA COMPLETED, CASH COMPLETED, DAVIVIENDA COMPLETED, OTHERS OPEN
- ℹ️ soportes con archivo conservado al final: 16 (por corregir de los lotes 1 a 5 y conflictos; OTHERS liberado a mano)
- ✅ una sola instancia, leader: {"instanceId":"ba833ec7f067:1:87d2dcc9","role":"leader","leaseHolder":"ba833ec7f067:1:87d2dcc9","leaseExpiresAt":"2026-10-31T22:48:42.180Z"}
- ✅ solo la alerta WEBHOOK_UNPARSED provocada (los webhooks reales del simulador se leen): 1 alertas

## Resumen del mes

| Lote | Bloque | Ejecuciones | Resultado | Lote al cierre | Envío (s) | Total (min) | Diferencias |
|---|---|---|---|---|---|---|---|
| 1 | CASH | 1 | COMPLETED | COMPLETED | 467.5 | 12.8 | 1 |
| 2 | AVVILLAS | 1 | COMPLETED | COMPLETED | 417.4 | 12 | 1 |
| 3 | BANCOLOMBIA | 1 | COMPLETED | COMPLETED | 461.6 | 12.7 | 1 |
| 4 | DAVIVIENDA | 2 | COMPLETED | COMPLETED | 438.1 | 12.4 | 1 |
| 5 | ANGLO | 1 | COMPLETED | COMPLETED | 433.7 | 12.2 | 1 |
| 6 | OTHERS | 1 | COMPLETED | COMPLETED | 422.1 | 12.1 | 1 |

Duración total: 76.4 min. Auditoría registrada: BATCH_REVIEWED ×12, RECEIPTS_UPLOADED ×8, BATCH_EXECUTED ×8, DUPLICATE_CONFLICT_RESOLVED ×6, SESSION_RENEWED ×4, SIGN_IN ×3, CONCEPT_CHANGED ×3, ARCHIVE_COPY_CHANGED ×2, BATCH_FILES_RELEASED ×2, ADDRESS_RELEASED ×1, RECEIPT_RESENT ×1, EXECUTION_ABORTED ×1, ALERT_ACKNOWLEDGED ×1.

### Lo que este mes no pudo provocar

- Excepción inesperada dentro de la ejecución → `INTERNAL_ERROR` y liberación del soporte (D32): no se puede provocar desde fuera sin inyectar una falla en el proceso; queda cubierta por las pruebas unitarias (`run-execution.test.ts`). El camino del operador (`abort`) sí se ejercitó.
- Rebote duro cuyo webhook se perdió, hallado por el barrido (D44): el mes perdió a propósito un webhook de entrega (`delivered`), no de rebote; el camino por los logs es el mismo.
- Evento muerto del *outbox* y su reintento manual (D39): el bus no falló durante el mes, así que `GET /outbox/dead` quedó vacío y `POST /outbox/dead/{id}/retry` no se ejercitó.

### Todas las diferencias (11)

- Lote 1 CASH · processfailed · Conjunto Palmas 100026 cash 26 CNCPT PAGO ADMINISTRACIÓN CNTRT 100026.pdf: esperado «carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED», ocurrió «carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED»
- Aborto del operador y asentamiento del lote (D32, D41), después del lote 1: ninguna ejecución en curso (el cerrojo global se liberó): GET /executions/current → 404 NO_EXECUTION: HTTP 200 {"executionId":"c7863ce6-45c7-4d86-a431-f82dcf1c8c0c","period":"2026-10","block":"CASH","manifestVersion":4,"startedBy":"operador","startedAt":"2026-10-31T21:44:48.469Z","finishedAt":"2026-10-31T21:44:53.495Z","result":"STOPPED","stopReason":"INTERRUPTED","batchState":"STOPPED","counters":{"total":1,"byState":{},"processed":0,"byErrorType":{}},"lastEventSeq":130}
- Lote 2 AVVILLAS · processfailed · Conjunto Almendros 100069 avvillas 19 CNCPT CUOTA EXTRA CNTRT 100069.pdf: esperado «carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED», ocurrió «carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED»
- Lote 3 BANCOLOMBIA · processfailed · Conjunto Almendros 100142 bancolombia 42 CNCPT CUOTA EXTRA CNTRT 100142.pdf: esperado «carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED», ocurrió «carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED»
- Lote 4 DAVIVIENDA · processfailed · Conjunto Guaduales 100178 davivienda 28 CNCPT MULTA CNTRT 100178.pdf: esperado «carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED», ocurrió «carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED»
- Lote 5 ANGLO · processfailed · Conjunto Pinos 700006 anglo 06 CNCPT MULTA CNTRT 700006.pdf: esperado «carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED», ocurrió «carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED»
- Lote 6 OTHERS · processfailed · Conjunto Almendros 100207 others 07 CNCPT PAGO ADMINISTRACIÓN CNTRT 100207.pdf: esperado «carga REGISTERED · SENT / entrega UNCONFIRMED · historial PROVIDER_PROCESS_FAILED», ocurrió «carga REGISTERED · SENT / entrega PROCESS_FAILED · historial SIN PROVIDER_PROCESS_FAILED»
- Liberación manual de archivos conservados (D51), después del lote 6: el resumen marca fileError FILE_NOT_AVAILABLE en los soportes por corregir, aparte de errorType: 5 marcados: NOT_FOUND_AT_PROVIDER ×1, CONTRACT_INACTIVE ×1, CONTRACT_NOT_FOUND ×1, PROVIDER_REJECTED ×1, CONTRACT_WITHOUT_EMAIL ×1
- Barrido de un webhook perdido (D44), al final del mes: sin falsa alarma de silencio de webhooks (D46): 1 alertas WEBHOOKS_NOT_RECEIVED
- Cierre del mes: salud, outbox, trabajos y sobrantes: outbox sin eventos por despachar: 1 pendientes
- Cierre del mes: salud, outbox, trabajos y sobrantes: los seis lotes terminaron COMPLETED: ANGLO COMPLETED, AVVILLAS COMPLETED, BANCOLOMBIA COMPLETED, CASH COMPLETED, DAVIVIENDA COMPLETED, OTHERS OPEN

