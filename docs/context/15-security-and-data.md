# 15. Security and data

| Topic | Definition |
|---|---|
| Operator authentication | Initial basic-authentication adapter: username and password with a strong hash (Argon2 or bcrypt), **short-lived JWT with renewal**; TLS is terminated by the backend itself, a plain connection is refused at the transport. One role: `operador`. Bulk Mailer does not administer accounts: an operator account is provisioned directly in the database by the deployment team, with the password already hashed; the backend ships a command that prints the hash of a password entered at that moment, and the product only reads accounts. **There are never default or seeded credentials.** Default lifetimes: access token 15 minutes, renewal credential 8 hours absolute (not extended by activity); both configurable. Failed sign-in distinguishes unknown user from wrong password; there is no lockout |
| Audit | Who synchronised, reviewed (the operator fetched the batch summary, recorded with its manifest version) and sent (with the manifest version), who resent, resolved uncertain sends, released addresses and changed the catalog or the copy setting; who signed in, failed to sign in or renewed a session. Every entry carries actor, typed action, UTC instant with millisecond precision, the subject acted on, previous value, new value and an optional evidence note. Entries are **append-only at product level and at storage level**: the product refuses changes with `AUDITORIA_INMUTABLE`, and the application's database credentials cannot update or delete them |
| Personal data | Receipts contain financial information and third-party data, subject to Law 1581 of 2012. No PDF copies are kept in the cloud |
| Retention | **Permanent** for Bulk Mailer records: receipts, hashes, attempts, recipients, events and audit |
| Secrets | In the secrets manager; never in code or in the repository |
| Integrity | Hash at synchronisation = hash at send (§5.2) |
| Non-production environments | **Every email is redirected to a test mailbox**, whatever the resolved recipient |
| Shared drive | Never expose SMB (port 445) to the Internet. Least-privilege service account. Access audit on the file server. Credential rotation |
