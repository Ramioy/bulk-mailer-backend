# 3. Periods, blocks and directories

The receipts are on the Active Directory shared drive, in one directory per period:

```
<configured root>/
└── OCTUBRE_2026/
    ├── EFECTIVO/
    ├── AVVILLAS/
    ├── BANCOLOMBIA/
    ├── DAVIVIENDA/
    ├── ANGLO/
    └── OTROS/
```

| Block | Directory | Receipts | Operating date | Contract source |
|---|---|---|---|---|
| 1 | `EFECTIVO` | Cash payments | Day 7 | Tayrona |
| 2 | `AVVILLAS` | AV Villas cheque | Day 12 | Tayrona |
| 3 | `BANCOLOMBIA` | Bancolombia cheque | Day 18 | Tayrona |
| 4 | `DAVIVIENDA` | Davivienda cheque | Day 23 | Tayrona |
| 5 | `ANGLO` | Anglo properties | Day 26 | SAP |
| 6 | `OTROS` | Cheque from other banks | Last day of the month | Tayrona |

- The root path is defined in configuration.
- **Operable periods:** only the current one and the previous one. "Current" is the calendar month of today's date in the `America/Bogota` time zone, which is set in configuration with that value as default.
- **Block order:** free. Operating dates are a calendar guide, not a system restriction.
- **Reference volume:** about 300 receipts per month across all blocks.
