import type { Clock } from '../../../ports/clock';

/** Deterministic clock: time moves only when told to; `sleep` returns at once and advances it. */
export class FixedClock implements Clock {
  private current: Date;
  readonly sleeps: number[] = [];

  constructor(start: Date | string = '2026-10-15T15:00:00Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(instant: Date | string): void {
    this.current = new Date(instant);
  }
}
