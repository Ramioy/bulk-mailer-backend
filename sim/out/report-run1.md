# Simulación de un mes: 2026-10

Inicio: 2026-10-31T13:37:03.602Z. App en modo producción contra simuladores de Tayrona, SAP y ZeptoMail (Docker).
Configuración: pausa entre envíos 1 s, espera de entrega hasta 120 s (consulta de logs cada 30 s), conciliación a 1/2/3 min, seguimiento 3 min después del lote, cierre a más tardar 300 s después del envío.

## Lote 1/6: CASH (día 7 del mes, fuente TAYRONA)

- Ejecución `d6480f67-02d9-4c0e-bdfb-cd2fdf177949`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.4 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **478.8 s** (11.1 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.4 s, máximo 121 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 2 (60 s en total)
- Cierre: 302.3 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 13 min** (781.6 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 36 |
| SENT / HARD_BOUNCE | 2 |
| SENT / UNCONFIRMED | 2 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / NOT_A_PDF | 1 |
| INVALID / INVALID_NAME | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / COMPLAINT | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |

Éxito (SENT entregado o con queja/rebote informado): 42 enviados de 43 listos; entregados (ACCEPTED) 36.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Pinos 100005 cash 05 CNCPT CUOTA EXTRA CNTRT 100005.pdf | SM_113 | carga REGISTERED · FAILED / PROVIDER_REJECTED | carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER | §12.4: SM_113 → FAILED / PROVIDER_REJECTED |

## Reenvío y liberación (después del lote 1)

Soporte: `Conjunto Ceibas 100014 cash 14 CNCPT MULTA CNTRT 100014.pdf` → conjunto100014+zm-hardbounce@clientes.test

- ✅ volver a subir el PDF (A2): {"fileName":"Conjunto Ceibas 100014 cash 14 CNCPT MULTA CNTRT 100014.pdf","outcome":"REGISTERED","sha256":"c08fc70f553e26af351e33fef305b20a6d1d98c68ccf27a2f7156cd55b22bb93","state":"SENT"}
- ✅ reenvío con la dirección suprimida → 409 EMAIL_SUPPRESSED: HTTP 409 {"error":"EMAIL_SUPPRESSED"}
- ✅ liberar la dirección (D19): HTTP 200 {"email":"conjunto100014+zm-hardbounce@clientes.test","provider":"CONFIRMED_BY_OPERATOR"}
- ✅ reenviar: HTTP 200 {"attemptId":"19d84db4-11dd-4634-a5d9-95c0bbd26974","state":"SENT","previousEmail":"conjunto100014+zm-hardbounce@clientes.test","email":"conjunto100014+zm-hardbounce@clientes.test"}
- ✅ el reenvío vuelve a rebotar (la dirección simulada siempre rebota) y queda suprimida: SENT / HARD_BOUNCE, suprimida: true

## Lote 2/6: AVVILLAS (día 12 del mes, fuente TAYRONA)

- Ejecución `30c3638d-eaba-4eed-be86-71ce93c55dec`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 42, por corregir 7
- Envío: 42 procesados en **421.8 s** (10 s por soporte)
- Espera de entrega: 40 esperas, promedio 8 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 2 (60 s en total)
- Cierre: 301 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.1 min** (723 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 34 |
| SENT / UNCONFIRMED | 2 |
| FAILED / NOT_FOUND_AT_PROVIDER | 2 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / COMPLAINT | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| PENDING / SOURCE_UNAVAILABLE | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |

Éxito (SENT entregado o con queja/rebote informado): 40 enviados de 42 listos; entregados (ACCEPTED) 34.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Cedros 100075 avvillas 25 CNCPT MULTA CNTRT 100075.pdf | SM_113 | carga REGISTERED · FAILED / PROVIDER_REJECTED | carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER | §12.4: SM_113 → FAILED / PROVIDER_REJECTED |

## Lote 3/6: BANCOLOMBIA (día 18 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ agregar concepto SANCIÓN: HTTP 201 {"key":"SANCIÓN","subject":"Sanción","active":true}

- Ejecución `6d9915c5-be3a-4dce-b4e2-4a1ef0933db1`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 50, duplicados descartados 0; listos para enviar 44, por corregir 5
- Envío: 44 procesados en **474.1 s** (10.8 s por soporte)
- Espera de entrega: 42 esperas, promedio 8 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 2 (60 s en total)
- Cierre: 302.7 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 13 min** (777 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 37 |
| SENT / HARD_BOUNCE | 2 |
| SENT / UNCONFIRMED | 2 |
| PENDING / CONTRACT_INACTIVE | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / COMPLAINT | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| INVALID / INVALID_NAME | 1 |
| INVALID / NOT_A_PDF | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |

Éxito (SENT entregado o con queja/rebote informado): 43 enviados de 44 listos; entregados (ACCEPTED) 37.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: 3**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Ceibas 100110 bancolombia 10 CNCPT multa CNTRT 100110.pdf | unknown-concept | carga REGISTERED · INVALID / UNKNOWN_CONCEPT | carga REGISTERED · sin registro | §4.2: concept not in the catalog (case-sensitive) |
| Conjunto Cedros 100111 bancolombia 11 CNCPT CUOTA EXTRA CNTRT 100111.pdf | duplicate | carga DUPLICATE | carga REGISTERED | §4.2/D2: same content as another file of the batch → discarded |
| Conjunto Altos 100124 bancolombia 24 CNCPT CUOTA EXTRA CNTRT 100124.pdf | SM_113 | carga REGISTERED · FAILED / PROVIDER_REJECTED | carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER | §12.4: SM_113 → FAILED / PROVIDER_REJECTED |

## Lote 4/6: DAVIVIENDA (día 23 del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ cambiar el asunto de MULTA a «Multa por convivencia»: HTTP 200 {"key":"MULTA","subject":"Multa por convivencia","active":true}
- ✅ activar la copia bcc: HTTP 200 {"enabled":true,"address":"archivo@anutibara.com"}

- Ejecución `242b793e-c88f-4518-8218-389b6a4e96a8`: **COMPLETED**, versión de manifiesto 1, copia bcc: archivo@anutibara.com
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **447.9 s** (10.4 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.4 s, máximo 121 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 2 (60 s en total)
- Cierre: 300.6 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.5 min** (748.8 s)
- ✅ Asunto de un correo de MULTA en ZeptoMail: «Multa por convivencia – Octubre 2026»

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 35 |
| FAILED / NOT_FOUND_AT_PROVIDER | 2 |
| SENT / HARD_BOUNCE | 2 |
| SENT / UNCONFIRMED | 2 |
| INVALID / NOT_A_PDF | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / INVALID_NAME | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| SENT / COMPLAINT | 1 |

Éxito (SENT entregado o con queja/rebote informado): 41 enviados de 43 listos; entregados (ACCEPTED) 35.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Arrayanes 100161 davivienda 11 CNCPT MULTA CNTRT 100161.pdf | SM_113 | carga REGISTERED · FAILED / PROVIDER_REJECTED | carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER | §12.4: SM_113 → FAILED / PROVIDER_REJECTED |

## Lote 5/6: ANGLO (día 26 del mes, fuente SAP)

**Administración antes del lote**

- ✅ retirar el concepto SANCIÓN: HTTP 200 {"key":"SANCIÓN","subject":"Sanción","active":false}

- Ejecución `e3da8326-aa34-482e-aa59-717083685a67`: **COMPLETED**, versión de manifiesto 1, copia bcc: archivo@anutibara.com
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 41, por corregir 8
- Envío: 41 procesados en **484.1 s** (11.8 s por soporte)
- Espera de entrega: 39 esperas, promedio 8.3 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 2 (90 s en total)
- Cierre: 300.8 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 13.1 min** (785.2 s)

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
| PENDING / CONTRACT_NOT_FOUND | 1 |
| SENT / COMPLAINT | 1 |
| FAILED / NOT_FOUND_AT_PROVIDER | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| SENT / SOFT_BOUNCE | 1 |

Éxito (SENT entregado o con queja/rebote informado): 40 enviados de 41 listos; entregados (ACCEPTED) 34.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Altos 700038 anglo 38 CNCPT MULTA CNTRT 700038.pdf | SM_113 | carga REGISTERED · FAILED / PROVIDER_REJECTED | carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER | §12.4: SM_113 → FAILED / PROVIDER_REJECTED |

## Lote 6/6: OTHERS (día último del mes, fuente TAYRONA)

**Administración antes del lote**

- ✅ desactivar la copia bcc: HTTP 200 {"enabled":false,"address":"archivo@anutibara.com"}

- Ejecución `c23fd2db-88f0-48b1-9cac-c0b82e65f702`: **COMPLETED**, versión de manifiesto 1, copia bcc: no
- Carga: 50 archivos en 0.2 s → registrados 49, duplicados descartados 1; listos para enviar 43, por corregir 6
- Envío: 43 procesados en **445.6 s** (10.4 s por soporte)
- Espera de entrega: 41 esperas, promedio 8.3 s, máximo 120 s; agotaron los 120 s: 1
- Pausas por incidentes del proveedor: 2 (60 s en total)
- Cierre: 300.8 s después del envío; quedaron pendientes de entrega 3
- **Duración total del lote: 12.4 min** (746.7 s)

**Resultado por estado**

| Estado / tipo de error / entrega | Soportes |
|---|---|
| SENT / ACCEPTED | 35 |
| FAILED / NOT_FOUND_AT_PROVIDER | 2 |
| SENT / UNCONFIRMED | 2 |
| SENT / HARD_BOUNCE | 2 |
| INVALID / INVALID_NAME | 1 |
| INVALID / UNKNOWN_CONCEPT | 1 |
| INVALID / NOT_A_PDF | 1 |
| PENDING / CONTRACT_INACTIVE | 1 |
| SENT / COMPLAINT | 1 |
| SENT / SOFT_BOUNCE | 1 |
| PENDING / CONTRACT_NOT_FOUND | 1 |
| PENDING / CONTRACT_WITHOUT_EMAIL | 1 |

Éxito (SENT entregado o con queja/rebote informado): 41 enviados de 43 listos; entregados (ACCEPTED) 35.

**Alertas del lote** (3): HARD_BOUNCE ×2, COMPLAINT ×1

**Diferencias con lo esperado: 1**

| Archivo | Escenario | Esperado | Ocurrió | Por qué se esperaba |
|---|---|---|---|---|
| Conjunto Pinos 100242 others 42 CNCPT MULTA CNTRT 100242.pdf | SM_113 | carga REGISTERED · FAILED / PROVIDER_REJECTED | carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER | §12.4: SM_113 → FAILED / PROVIDER_REJECTED |

## Resumen del mes

| Lote | Bloque | Resultado | Envío (s) | Total (min) | Diferencias |
|---|---|---|---|---|---|
| 1 | CASH | COMPLETED | 478.8 | 13 | 1 |
| 2 | AVVILLAS | COMPLETED | 421.8 | 12.1 | 1 |
| 3 | BANCOLOMBIA | COMPLETED | 474.1 | 13 | 3 |
| 4 | DAVIVIENDA | COMPLETED | 447.9 | 12.5 | 1 |
| 5 | ANGLO | COMPLETED | 484.1 | 13.1 | 1 |
| 6 | OTHERS | COMPLETED | 445.6 | 12.4 | 1 |

Duración total: 76.1 min. Auditoría registrada: RECEIPTS_UPLOADED ×7, BATCH_REVIEWED ×6, BATCH_EXECUTED ×6, SESSION_RENEWED ×4, CONCEPT_CHANGED ×3, ARCHIVE_COPY_CHANGED ×2, SIGN_IN ×1, ADDRESS_RELEASED ×1, RECEIPT_RESENT ×1.

### Todas las diferencias (8)

- Lote 1 CASH · SM_113 · Conjunto Pinos 100005 cash 05 CNCPT CUOTA EXTRA CNTRT 100005.pdf: esperado «carga REGISTERED · FAILED / PROVIDER_REJECTED», ocurrió «carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER»
- Lote 2 AVVILLAS · SM_113 · Conjunto Cedros 100075 avvillas 25 CNCPT MULTA CNTRT 100075.pdf: esperado «carga REGISTERED · FAILED / PROVIDER_REJECTED», ocurrió «carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER»
- Lote 3 BANCOLOMBIA · unknown-concept · Conjunto Ceibas 100110 bancolombia 10 CNCPT multa CNTRT 100110.pdf: esperado «carga REGISTERED · INVALID / UNKNOWN_CONCEPT», ocurrió «carga REGISTERED · sin registro»
- Lote 3 BANCOLOMBIA · duplicate · Conjunto Cedros 100111 bancolombia 11 CNCPT CUOTA EXTRA CNTRT 100111.pdf: esperado «carga DUPLICATE», ocurrió «carga REGISTERED»
- Lote 3 BANCOLOMBIA · SM_113 · Conjunto Altos 100124 bancolombia 24 CNCPT CUOTA EXTRA CNTRT 100124.pdf: esperado «carga REGISTERED · FAILED / PROVIDER_REJECTED», ocurrió «carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER»
- Lote 4 DAVIVIENDA · SM_113 · Conjunto Arrayanes 100161 davivienda 11 CNCPT MULTA CNTRT 100161.pdf: esperado «carga REGISTERED · FAILED / PROVIDER_REJECTED», ocurrió «carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER»
- Lote 5 ANGLO · SM_113 · Conjunto Altos 700038 anglo 38 CNCPT MULTA CNTRT 700038.pdf: esperado «carga REGISTERED · FAILED / PROVIDER_REJECTED», ocurrió «carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER»
- Lote 6 OTHERS · SM_113 · Conjunto Pinos 100242 others 42 CNCPT MULTA CNTRT 100242.pdf: esperado «carga REGISTERED · FAILED / PROVIDER_REJECTED», ocurrió «carga REGISTERED · FAILED / NOT_FOUND_AT_PROVIDER»

