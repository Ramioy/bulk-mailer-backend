# 5. File type validation

## 5.1 Why the first bytes are not enough

Checking that the file starts with `%PDF-` (its "signature") **guarantees nothing**. The OWASP file upload guide says the signature *"should not be used on its own, as bypassing it is pretty common and easy"*. The known techniques:

| Technique | What it does | Why the signature does not detect it |
|---|---|---|
| **Polyglot** | The same file is valid in two formats, e.g. PDF and ZIP, HTML or executable | The PDF signature is present. Also, readers accept `%PDF` anywhere in the first 1,024 bytes, so data of another format fits in front |
| **Active content** | The PDF contains `/JavaScript`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA` or `/SubmitForm`, capable of executing actions or carrying embedded files | It is a valid PDF |
| **Obfuscation** | Names are encoded (`/J#61vaScript`) or hidden inside compressed streams (`/ObjStm`) | A plain-text search does not see them; a real parser is needed |
| **Incremental update** | A revision is appended at the end of the file that **replaces the visible content** (figures, accounts) without rebuilding the document. It is the basis of *shadow attacks* | The file is still a valid PDF with the same signature |
| **Malformed file** | Structure built to exploit parser bugs | It can pass the signature and compromise the validator itself |

## 5.2 Controls

Validation is done **on-premise, in the agent, during synchronisation**, before the file leaves the network. The verdict is bound to the hash. When sending, the agent recomputes the hash: if it matches, the verdict still holds; if not, the receipt fails with `ARCHIVO_MODIFICADO`.

The system **does not modify or "sanitise" the PDFs**: that would alter a financial receipt. Files that do not pass are rejected and reported.

| # | Control | Rejection |
|---|---|---|
| 1 | Size (by `stat`, without reading the file) is ≤ 15 MB. Checked **before** reading or parsing | `ADJUNTO_DEMASIADO_GRANDE` |
| 2 | Strict signature: `%PDF-1.x` or `%PDF-2.0` at **byte 0**, nothing in front, and `%%EOF` as the last non-empty element | `ARCHIVO_NO_ES_PDF` |
| 3 | Full structural analysis with a strict parser (e.g. `qpdf --check`). Runs in an **isolated process**, without network, with memory and time limits | `ARCHIVO_NO_ES_PDF` |
| 4 | The PDF does not ask for a password to open | `PDF_CIFRADO` |
| 5 | No active content. The objects of §5.1 are searched **after the parser decompresses the streams and decodes the names** | `PDF_CONTENIDO_ACTIVO` |
| 6 | Number of incremental revisions ≤ the configured threshold. Default 0 (a single revision). Calibrated in the pilot with real receipts from the system that generates them | `PDF_MODIFICADO` |
| 7 | Antivirus with up-to-date signatures (e.g. ClamAV on the agent host) | `ARCHIVO_MALICIOSO`, with **immediate alert to IT/Security** |
| 8 | The attachment is always declared as `application/pdf` | — |
