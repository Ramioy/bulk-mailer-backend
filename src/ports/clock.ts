export interface Clock {
  now(): Date;
  /**
   * Waits the given milliseconds. Fakes return immediately and move their time forward.
   * With a `signal`, the wait ends early (without error) once it is aborted, so a shutdown does not sit out a
   * growing wait (D33).
   */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
