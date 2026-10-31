/** Short description of a failed fetch: the network error code when there is one (ECONNREFUSED, ENOTFOUND…). */
export function networkError(error: unknown): string {
  if ((error as Error).name === 'TimeoutError') return 'timeout';
  const cause = (error as { cause?: { code?: string; errors?: Array<{ code?: string }>; cause?: { code?: string } } }).cause;
  return cause?.code ?? cause?.errors?.[0]?.code ?? cause?.cause?.code ?? String(error);
}
