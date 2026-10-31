import type { FileInspector, FileVerdict } from '../../../ports/file-inspector';

/** Accepts every file unless a verdict is configured for its exact content. */
export class FakeFileInspector implements FileInspector {
  private readonly verdicts = new Map<string, FileVerdict>();

  async inspect(content: Uint8Array): Promise<FileVerdict> {
    return this.verdicts.get(Buffer.from(content).toString('base64')) ?? { ok: true };
  }

  rejectContent(content: Uint8Array, verdict: Extract<FileVerdict, { ok: false }>): void {
    this.verdicts.set(Buffer.from(content).toString('base64'), verdict);
  }
}
