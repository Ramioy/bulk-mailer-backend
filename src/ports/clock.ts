export interface Clock {
  now(): Date;
  /** Waits the given milliseconds. Fakes return immediately and move their time forward. */
  sleep(milliseconds: number): Promise<void>;
}
