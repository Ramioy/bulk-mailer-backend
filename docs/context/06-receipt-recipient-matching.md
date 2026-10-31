# 6. Receipt ↔ recipient matching

The matching is established by the **file name**, which the operator prepares. The contract does not appear inside the PDF, so **verifying that the contract is correct is the operator's responsibility**. To make it easier, before sending the system shows, next to each file, the **complex name and the email** returned by the source.

## 6.1 Contract of the contracts API (Tayrona and SAP)

Both sources expose the same interface, and Bulk Mailer consumes it through the `FuenteContratos` port:

```
GET /contratos/{contrato}
200 → { "contrato": "104522", "activo": true, "nombre_conjunto": "Edificio Altos", "correo": "admin@altos.com" }
404 → the contract does not exist
```

| Response | Result |
|---|---|
| `200`, `activo = true` and `correo` with valid syntax | Recipient resolved |
| `404` | `CONTRATO_NO_EXISTE` |
| `200` with `activo = false` | `CONTRATO_INACTIVO` |
| `200` with empty or invalid `correo` | `CONTRATO_SIN_CORREO` |
| Timeout, network error or `5xx` | `FUENTE_NO_DISPONIBLE` |

- **A receipt relates to a single email.**
- The API returns a single email per contract.
- If several receipts have the same contract (e.g. administration and extra fee), each one is a separate email to the same recipient. **They are not duplicates.**
- Communication is over HTTPS and authenticated with a service token. The maximum wait time is configurable (5 s by default).
- Production connects to the real APIs. Outside production a simulated adapter can be used.

## 6.2 Verification moments

| Moment | What is verified |
|---|---|
| **Synchronisation** | The recipient of every valid receipt is resolved and compared with the local suppression list (§10.3). |
| **Send** | The source is queried again. If the email **differs from the one in the manifest**, the receipt is not sent (`DESTINATARIO_CAMBIO`) and the operator must synchronise and review again. |
