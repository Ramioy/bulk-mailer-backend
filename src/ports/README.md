# ports

Interfaces the core needs from the outside world (`Authenticator`, `BulkMailerRepository`, `JobQueue`, `EventBus`,
`ReceiptFileStore`, `FileInspector`, `ContractSource`, `EmailProvider`, `SendLookup`, `SuppressionManager`,
`ProgressNotifier`, `AlertNotifier`, `SecretStore`, `Clock`). May import only from `domain` and `ports`.
