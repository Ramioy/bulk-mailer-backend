import { isReadyToSend, type Manifest, type ManifestEntry } from '../../domain/batch/manifest';
import { inConflict } from '../../domain/receipt/receipt';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';

/**
 * Manifest entries whose receipt is still ready to send now. A SENT receipt never enters an execution again,
 * even when re-running the same version after a stop.
 */
export async function readyManifestEntries(stores: Pick<BulkMailerStores, 'receipts'>, manifest: Manifest): Promise<ManifestEntry[]> {
  const ready: ManifestEntry[] = [];
  for (const entry of manifest.entries) {
    const receipt = await stores.receipts.get(entry.sha256);
    if (
      receipt &&
      isReadyToSend({
        sha256: receipt.sha256,
        state: receipt.state,
        fileName: receipt.fileName,
        conceptKey: receipt.conceptKey ?? '',
        contract: receipt.contract ?? '',
        email: receipt.recipient?.email,
        fileAvailable: receipt.fileAvailable,
        inConflict: inConflict(receipt),
      })
    ) {
      ready.push(entry);
    }
  }
  return ready;
}
