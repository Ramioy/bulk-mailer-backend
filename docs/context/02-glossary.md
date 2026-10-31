# 2. Glossary

| Term | Definition |
|---|---|
| **Period** | Billing month, in the format `MES_AÑO` (month in Spanish, upper case), e.g. `OCTUBRE_2026`. |
| **Block** | Group of receipts by payment method. There are six per period (§3). |
| **Batch** | Set of receipts of one *(period, block)*. It is the unit of operation. |
| **Receipt** (*soporte*) | PDF file in the batch. Identified by the **SHA-256 of its content**. |
| **Manifest** | Versioned snapshot of the receipts ready to send in a batch, with their recipients. It is what the operator reviews and what the system sends. |
| **Attempt** (*intento*) | Each send call of a receipt to ZeptoMail. It has an `intento_id` (UUID), which travels as `client_reference`. |
| **Contract source** | System that returns the email of the complex for each contract: Tayrona or SAP. |
| **Agent** | On-premise component that reads the shared drive and delivers the files to the backend (§14). |
