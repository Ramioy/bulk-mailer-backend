# Simulación de un mes: 2026-10

Inicio: 2026-10-31T15:00:16.595Z. App en modo producción contra simuladores de Tayrona, SAP y ZeptoMail (Docker).
Configuración: pausa entre envíos 1 s, espera de entrega hasta 120 s (consulta de logs cada 30 s), conciliación a 1/2/3 min, seguimiento 3 min después del lote, cierre a más tardar 300 s después del envío.

## Lote 1/6: CASH (día 7 del mes, fuente TAYRONA)

- Ejecución `06d24b2f-9e19-408e-83f3-67f5125c30b4`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.3 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **441.1 s** (10.3 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.2 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301.6 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.4 min** (743 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 36 |
| SENT / HARD_BOUNCE | 2 |
| SENT / UNCONFIRMED | 2 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / NOT_A_PDF | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| INVALID / INVALID_NAME | 1 |
| SENT / COMPLAINT | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| FAILED / PROVIDER_REJECTED | 1 |

Éxito (SENT entregado o con queja/rebote informado): 42 enviados de 43 listos; entregados (ACCEPTED) 36.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: ninguna.**


## Reenvío y liberación (después del lote 1)

Soporte: `Conjunto Ceibas 100014 cash 14 CNCPT MULTA CNTRT 100014.pdf` → conjunto100014+zm-hardbounce@clientes.test

- ✅ volver a subir el PDF (A2): {"fileName":"Conjunto Ceibas 100014 cash 14 CNCPT MULTA CNTRT 100014.pdf","outcome":"REGISTERED","sha256":"c08fc70f553e26af351e33fef305b20a6d1d98c68ccf27a2f7156cd55b22bb93","state":"SENT"}
- ✅ reenvío con la dirección suprimida → 409 EMAIL_SUPPRESSED: HTTP 409 {"error":"EMAIL_SUPPRESSED"}
- ✅ liberar la dirección (D19): HTTP 200 {"email":"conjunto100014+zm-hardbounce@clientes.test","provider":"CONFIRMED_BY_OPERATOR"}
- ✅ reenviar: HTTP 200 {"attemptId":"d3354041-4a0c-403e-823e-501cbf0333ca","state":"SENT","previousEmail":"conjunto100014+zm-hardbounce@clientes.test","email":"conjunto100014+zm-hardbounce@clientes.test"}
- ✅ el reenvío vuelve a rebotar (la dirección simulada siempre rebota) y queda suprimida: SENT / HARD_BOUNCE, suprimida: true

## Lote 2/6: AVVILLAS (día 12 del mes, fuente TAYRONA)

- Ejecución `ce55beeb-a6bd-416a-a9a4-8d154b6b7816`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 42, por corregir 7
- Envío: 42 procesados en **391.6 s** (9.3 s por soporte)
- Espera de entrega: 40 esperas, promedio 8 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 300.8 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 11.5 min** (692.8 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 34 |
| SENT / UNCONFIRMED | 2 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |
| SENT / SOFT_BOUNCE | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / COMPLAINT | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| PENDING / SOURCE_UNAVAILABLE | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |

Éxito (SENT entregado o con queja/rebote informado): 40 enviados de 42 listos; entregados (ACCEPTED) 34.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: ninguna.**


## Lote 3/6: BANCOLOMBIA (día 18 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ agregar concepto SANCIÓN: HTTP 201 {"key":"SANCIÓN","subject":"Sanción","active":true}

- Ejecución `997e5e19-8e74-4cfe-891a-5ebe1b79f0ee`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **440.8 s** (10.3 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.2 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301.6 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.4 min** (742.8 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 36 |
| SENT / HARD_BOUNCE | 2 |
| SENT / UNCONFIRMED | 2 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| SENT / COMPLAINT | 1 |

Éxito (SENT entregado o con queja/rebote informado): 42 enviados de 43 listos; entregados (ACCEPTED) 36.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: ninguna.**


## Lote 4/6: DAVIVIENDA (día 23 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ cambiar el asunto de MULTA a «Multa por convivencia»: HTTP 200 {"key":"MULTA","subject":"Multa por convivencia","active":true}
- ✅ activar la copia bcc: HTTP 200 {"enabled":true,"address":"archivo@anutibara.com"}

- Ejecución `7ac60458-549c-4738-b5e4-49deceab0aab`: **COMPLETED**, versión de manifiesto 1, copia bcc: archivo@anutibara.com
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **410.1 s** (9.5 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.2 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 302.4 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 11.9 min** (712.7 s)
- ✅ Asunto de un correo de MULTA en ZeptoMail: «Multa por convivencia – Octubre 2026»

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 35 |
| SENT / HARD_BOUNCE | 2 |
| SENT / UNCONFIRMED | 2 |
| INVALID / NOT_A_PDF | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / INVALID_NAME | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| SENT / COMPLAINT | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |

Éxito (SENT entregado o con queja/rebote informado): 41 enviados de 43 listos; entregados (ACCEPTED) 35.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: ninguna.**


## Lote 5/6: ANGLO (día 26 del mes, fuente SAP)

**Administración antes del lote**

- ✅ retirar el concepto SANCIÓN: HTTP 200 {"key":"SANCIÓN","subject":"Sanción","active":false}

- Ejecución `b6f7cbf7-15fb-4c44-8ad7-48f079a3d986`: **COMPLETED**, versión de manifiesto 1, copia bcc: archivo@anutibara.com
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 41, por corregir 8
- Envío: 41 procesados en **436.6 s** (10.6 s por soporte)
- Espera de entrega: 39 esperas, promedio 8.6 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301.7 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.3 min** (738.6 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 34 |
| INVALID / UNKNOWN_CONCEPT | 3 |
| SENT / UNCONFIRMED | 2 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / COMPLAINT | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| SENT / SOFT_BOUNCE | 1 |

Éxito (SENT entregado o con queja/rebote informado): 40 enviados de 41 listos; entregados (ACCEPTED) 34.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: ninguna.**


## Lote 6/6: OTHERS (día último del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ desactivar la copia bcc: HTTP 200 {"enabled":false,"address":"archivo@anutibara.com"}

- Ejecución `633bddbc-4bd4-450e-b884-9b509ddc281d`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **430.6 s** (10 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.7 s, máximo 121 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 1 (30 s en total)
- Cierre: 301.7 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.2 min** (732.6 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 35 |
| SENT / UNCONFIRMED | 2 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / INVALID_NAME | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / NOT_A_PDF | 1 |
| SENT / COMPLAINT | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| FAILED / PROVIDER_REJECTED | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |

Éxito (SENT entregado o con queja/rebote informado): 41 enviados de 43 listos; entregados (ACCEPTED) 35.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: ninguna.**


## Resumen del mes

| Lote | Bloque | Resultado | Envío (s) | Total (min) | Diferencias |
|---|---|---|---|---|---|
| 1 | CASH | COMPLETED | 441.1 | 12.4 | 0 |
| 2 | AVVILLAS | COMPLETED | 391.6 | 11.5 | 0 |
| 3 | BANCOLOMBIA | COMPLETED | 440.8 | 12.4 | 0 |
| 4 | DAVIVIENDA | COMPLETED | 410.1 | 11.9 | 0 |
| 5 | ANGLO | COMPLETED | 436.6 | 12.3 | 0 |
| 6 | OTHERS | COMPLETED | 430.6 | 12.2 | 0 |

Duración total: 72.8 min. Auditoría registrada: RECEIPTS_UPLOADED ×7, BATCH_REVIEWED ×6, BATCH_EXECUTED ×6, SESSION_RENEWED ×4, CONCEPT_CHANGED ×3, ARCHIVE_COPY_CHANGED ×2, SIGN_IN ×1, ADDRESS_RELEASED ×1, RECEIPT_RESENT ×1.

### Sin diferencias con lo esperado


