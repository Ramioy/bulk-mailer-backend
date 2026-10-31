# application

Use cases (`UploadReceipts`, `ExecuteBatch`, …). They orchestrate the domain through ports.
May import only from `domain`, `ports` and `application`.

## Rule: two phases (D36, D37)

1. **Outside the serial executor:** every call to an external service (contract sources, `FileInspector`, the
   email provider, the logs API) and the work that does not depend on the current state (hashing, parsing, reading
   a file). A cheap refusal may be checked here too, to avoid useless calls, but it is not trusted.
2. **Inside the serial executor, in one short transaction:** read again everything the decision depends on
   (`refuseBatchCommand(deps, period, tx)`, the receipt, the batch, the suppression list…), apply the rules to that
   state, write, and add the domain events to `tx.outbox`. No external call here (`test/support/serial-guard.ts`
   checks it).

A command that must call the provider between two writes (an execution, a resend) has three sections: record the
attempt inside, call outside, record the outcome inside; an exception between them releases the receipt (D32).

Every `receipts.save` / `batches.save` takes an entity read **in the same transaction** (or returned by a previous
`save` in it): the stores check its `version` and refuse a stale one (`ConcurrentModificationError`). That error is a
bug in our own serialisation: it is not caught and retried.
