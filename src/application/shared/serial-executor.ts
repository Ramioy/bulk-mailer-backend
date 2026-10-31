/**
 * Runs commands one at a time. Commands that change a batch (upload, remove, refresh, start an execution)
 * go through it so that two of them never interleave and produce the same manifest version twice.
 * Enough for the single instance agreed in the architecture.
 */
export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(command: () => Promise<T>): Promise<T> {
    const result = this.tail.then(command, command);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
