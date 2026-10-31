# 4. File name

## 4.1 Format

The name starts with free text (property and details) and ends with two abbreviations, each followed by a space and its value:

```
<property and details> CNCPT <concept> CNTRT <contract>.pdf
```

- `CNCPT <concept>` must match exactly one concept of the **catalog** (§4.3).
- `CNTRT <contract>` is the contract number used to query the source.

## 4.2 Validation rules

Validation is done on the name only, without interpreting the PDF content. In this order:

1. **Unicode NFC normalisation** of the name. Thus, a composed `Ó` and `O + ´` are treated the same.
2. `CNCPT` and `CNTRT` appear **exactly once** each in the name.
3. The name matches the regular expression, which is **case-sensitive**:

   ```regex
   ^(?<detalle>\S(?:.*\S)?) CNCPT (?<concepto>\S+(?: \S+)*) CNTRT (?<contrato>[1-9]\d*)\.pdf$
   ```

   - There is exactly one space before and after each abbreviation.
   - The concept does not allow double spaces.
   - The contract has digits only and **does not allow leading zeros**. Zeros can be allowed by configuration; in that case they are stripped before querying the source.
   - The extension is `.pdf` in lower case.
4. The concept exists in the catalog and is active.
5. The full name has at most **150 characters**, ZeptoMail's limit for the attachment name.

| Name | Result |
|---|---|
| `Edificio Altos Torre 2 oct CNCPT CUOTA EXTRA CNTRT 104522.pdf` | ✅ concept `CUOTA EXTRA`, contract `104522` |
| `Conjunto Las Palmas CNCPT PAGO ADMINISTRACIÓN CNTRT 98765.pdf` | ✅ |
| `Conjunto Las Palmas CNCPT PAGO ADMINISTRACIÓN CNTRT 98 765.pdf` | ❌ the contract has a space |
| `Conjunto Las Palmas CNTRT 98765 CNCPT MULTA.pdf` | ❌ reversed order |
| `Conjunto Las Palmas CNCPT  MULTA CNTRT 98765.pdf` | ❌ double space after `CNCPT` |
| `Conjunto Las Palmas CNCPT CUOTA  EXTRA CNTRT 98765.pdf` | ❌ double space inside the concept |
| `Conjunto Las Palmas cncpt MULTA cntrt 98765.pdf` | ❌ abbreviations in lower case |
| `Conjunto Las Palmas CNCPT MULTA CNTRT 98765.PDF` | ❌ extension in upper case |
| `Conjunto Las Palmas CNCPT Multa CNTRT 98765.pdf` | ❌ concept not in the catalog (case-sensitive) |
| `Conjunto Las Palmas CNCPT MULTA CNTRT 098765.pdf` | ❌ leading zero |
| `Conjunto Las Palmas CNCPT MULTA CNTRT 111 CNTRT 222.pdf` | ❌ `CNTRT` repeated |
| `Conjunto Las Palmas MULTA 98765.pdf` | ❌ abbreviations missing |

## 4.3 Concept catalog

The catalog is managed from the system: concepts can be added and retired, and every change is audited. Each concept has:

| Field | Use |
|---|---|
| `clave` | Exact text that goes in the file name, after `CNCPT`. |
| `asunto` | Text of the concept in the email subject. |
| `activo` | A retired concept is no longer accepted in later synchronisations. It does not affect what was already sent. |

Initial catalog:

| `clave` | `asunto` |
|---|---|
| `PAGO ADMINISTRACIÓN` | Pago administración |
| `CUOTA EXTRA` | Cuota extra |
| `MULTA` | Multa |
