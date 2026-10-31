export interface PollingLogger {
  error(message: string): void;
}

/** Runs `task` every `pollMs` until stopped; one run at a time; errors are logged, never thrown. */
export class PollingLoop {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly name: string,
    private readonly task: () => Promise<unknown>,
    private readonly pollMs: number,
    private readonly logger: PollingLogger,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.task()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.error(`${this.name}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.schedule());
    }, this.pollMs);
  }
}
