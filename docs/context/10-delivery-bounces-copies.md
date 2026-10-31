# 10. Delivery, bounces and copies

## 10.1 Hard bounce

**Permanent** failure: non-existent address or domain, deactivated account or destination server policy (SMTP 5.x.x codes).

1. The webhook or reconciliation detects it. Delivery becomes `REBOTE_DURO`, with the reason and the diagnostic message.
2. ZeptoMail suppresses the address (§10.3) and Bulk Mailer adds it to its local suppression list.
3. The interface shows the receipt as **"Not delivered"**.
4. The operator asks for the contract's email to be corrected in Tayrona or SAP, which are the source of truth.
5. The operator uses **Resend** (§10.4).

## 10.2 Spam complaint

Treated like a hard bounce. Delivery becomes `QUEJA`, the address is suppressed, an alert is generated and **nothing is resent automatically**. The operator contacts the complex's administration. *Resend* follows the same rule as §10.4.

## 10.3 Suppression

- In ZeptoMail, **automatic suppression is explicitly enabled** at the service Agent level. It applies to complaints and to non-existent user, mailbox or domain. A suppressed address receives no more emails.
- Bulk Mailer keeps a **local suppression list**, fed by hard-bounce and complaint webhooks. It is checked when synchronising and when sending, and the affected receipt shows `CORREO_SUPRIMIDO`. Thus the system does not depend on how ZeptoMail responds to a suppressed address.
- **Releasing an address** is a single, atomic, audited action of Bulk Mailer, through the `GestorSupresiones` port (§14.2). It only proceeds if the business confirms the address is valid:
  1. The operator confirms the business validation and writes an evidence note.
  2. Bulk Mailer removes the address from ZeptoMail's suppression list through the suppressions API.
  3. Only when ZeptoMail confirms the removal, or answers that the address is not suppressed, is the address removed from the local list, and the action is audited (who, when, evidence note).
  4. If the suppressions API fails, nothing is released and the operator sees the typed error. An address is never released on one side only.

  Why: ZeptoMail's response to a suppressed address is undocumented (§12.7). A resend to an address released only locally could show as `ENVIADO` and never be delivered.

## 10.4 Resend

A manual action on an individual receipt. Only available if its delivery is `REBOTE_DURO` or `QUEJA`.

1. The system queries the source.
2. If the current email **is different** from the one that failed, it creates a new attempt (same hash, new `intento_id`) and sends it.
3. If it is **the same**, it blocks the resend with `CORREO_SUPRIMIDO`, unless the address has been released (§10.3).
4. It is audited: who, when, previous email and new email.

## 10.5 Archive copy (`bcc`)

- It is a **general setting** of the system: **disabled by default**. The operator enables or disables it from the interface, and every change is audited (who, when, previous value).
- The copy address is defined in configuration.
- The value in force when an execution starts applies to that whole execution. Each attempt records whether it carried a copy and to which address.
- With the copy active, each email has two recipients and ZeptoMail reports events for each one separately. **The receipt's delivery state is computed only from the primary recipient's events.** A bounce of the copy mailbox generates an alert for the administrator and does not affect the receipt.
- Each copy consumes one additional email from the credits.
