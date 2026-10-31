import type { ProgressNotifier, StoredProgressEvent } from '../../../ports/progress-notifier';

export type ProgressListener = (event: StoredProgressEvent) => void;

/** In-process fan-out of stored progress events to the open SSE streams of each execution. */
export class SseProgressHub implements ProgressNotifier {
  private readonly listeners = new Map<string, Set<ProgressListener>>();

  publish(event: StoredProgressEvent): void {
    for (const listener of this.listeners.get(event.executionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken stream never affects the execution.
      }
    }
  }

  subscribe(executionId: string, listener: ProgressListener): () => void {
    const set = this.listeners.get(executionId) ?? new Set<ProgressListener>();
    set.add(listener);
    this.listeners.set(executionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(executionId);
    };
  }
}
