import type { FileErrorType } from '../domain/shared/error-types';

export type FileVerdict = { readonly ok: true } | { readonly ok: false; readonly error: FileErrorType; readonly detail?: string };

/** Decides whether a file is an acceptable PDF. The verdict is bound to the file hash. */
export interface FileInspector {
  inspect(content: Uint8Array): Promise<FileVerdict>;
}
