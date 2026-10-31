import type { FileInspector, FileVerdict } from '../../../ports/file-inspector';

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export interface BasicPdfInspectorOptions {
  /** Incremental revisions allowed after the original; default 0 (calibrated in the pilot). */
  readonly maxIncrementalUpdates: number;
  /**
   * D50: largest file accepted; default 15 MB. Base64 makes the message about a third larger: what ZeptoMail accepts
   * for the encoded message is still to be confirmed with the account (§12.7).
   */
  readonly maxAttachmentBytes?: number;
}

const SIGNATURE = /^%PDF-(1\.[0-7]|2\.0)/;
const PDF_DELIMITER = String.raw`(?=[\s/<>\[\]()%{}]|$)`;
const ACTIVE_CONTENT = new RegExp(
  String.raw`/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm)${PDF_DELIMITER}`,
);
const ENCRYPT = new RegExp(String.raw`/Encrypt${PDF_DELIMITER}`);

/**
 * Simple verification agreed for this stage (docs/architecture/arquitectura.md §2.1). It reads the raw bytes:
 * it does not see names obfuscated or hidden in compressed streams, does not detect files built to exploit
 * parsers and runs no antivirus. A qpdf + ClamAV inspector replaces it when the service grows.
 */
export class BasicPdfInspector implements FileInspector {
  constructor(private readonly options: BasicPdfInspectorOptions = { maxIncrementalUpdates: 0 }) {}

  async inspect(content: Uint8Array): Promise<FileVerdict> {
    if (content.length > (this.options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES)) return { ok: false, error: 'ATTACHMENT_TOO_LARGE' };

    // latin1 maps every byte to one character, so offsets and binary content are preserved.
    const text = Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('latin1');
    if (!SIGNATURE.test(text)) return { ok: false, error: 'NOT_A_PDF', detail: 'missing %PDF- signature at byte 0' };
    if (!text.trimEnd().endsWith('%%EOF')) return { ok: false, error: 'NOT_A_PDF', detail: '%%EOF is not the last element' };

    if (ENCRYPT.test(text)) return { ok: false, error: 'PDF_ENCRYPTED' };

    const active = ACTIVE_CONTENT.exec(text);
    if (active) return { ok: false, error: 'PDF_ACTIVE_CONTENT', detail: `/${active[1]}` };

    const revisions = text.split('%%EOF').length - 1;
    if (revisions - 1 > this.options.maxIncrementalUpdates) {
      return { ok: false, error: 'PDF_INCREMENTAL_UPDATE', detail: `${revisions - 1} incremental update(s)` };
    }
    return { ok: true };
  }
}
