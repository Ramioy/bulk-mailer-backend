# 14. Architecture

## 14.1 Deployment

- **Backend:** NestJS (Node.js) with hexagonal architecture, in the **cloud (Linux)**. Database: **PostgreSQL 18** (§18 #7).
- **Web client:** separate repository.
- **On-premise agent:** inside the corporate network, next to the shared drive.

## 14.2 Ports and adapters

| Port | Responsibility | Adapters |
|---|---|---|
| `RepositorioSoportes` | `listar(periodo, bloque)` and `leer(ruta)`, with hash and validation verdict | **On-premise agent** (primary) · direct SMB (for VPN or local development) |
| `FuenteContratos` | `obtener(contrato)` (§6.1) | Tayrona API · SAP API · simulated (outside production only) |
| `ProveedorCorreo` | Send a message and classify the response (§9.2) | ZeptoMail API |
| `ConsultaEnvios` | Look up a send by `client_reference` | ZeptoMail logs API (OAuth) |
| `ReceptorEventosEntrega` | Receive and validate delivery events | ZeptoMail webhooks |
| `ColaDeTrabajo` | Batch execution, reconciliation and event processing, with recovery after crashes | Jobs table + *outbox* in PostgreSQL 18 (`FOR UPDATE SKIP LOCKED`) · **Kafka in the future** |
| `BusDeEventos` | Domain and progress events | *Outbox* in the database · Kafka in the future |
| `NotificadorProgreso` | Real-time progress to the interface | SSE |
| `Autenticacion` | Operator identity | Basic authentication with JWT (§15) · AD or Entra ID in the future |
| `AlmacenSecretos` | Credentials | Environment secrets manager |
| `NotificadorAlertas` | Deliver a typed alert (batch stopped, malicious file, hard bounce, complaint, webhooks not arriving) to every registered provider. Providers are registered by configuration; every alert is persisted regardless of the providers | Interface (persisted alert shown in the UI; the only one for now) · other providers in the future |
| `GestorSupresiones` | Remove an address from the provider's suppression list, as part of the atomic release of §10.3 | ZeptoMail suppressions API (OAuth) |

## 14.3 On-premise agent

- **Outbound-only connection.** The agent opens a persistent encrypted channel (WebSocket or gRPC with mTLS) to the backend and receives the `listar` and `leer` requests through it. **No inbound port is opened** in the corporate network.
- Reads the shared drive with a **read-only service account** (gMSA), with Kerberos and SMB 3.x encryption.
- Computes hashes and runs the validation of §5 (isolated parser and antivirus).
- Transmits the PDF only when sending, streamed and without leaving copies.

If IT/Security does not approve the agent, the alternative is a **site-to-site VPN** restricted to the file server with the direct SMB adapter. The domain does not change.
