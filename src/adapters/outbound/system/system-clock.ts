import { setTimeout as delay } from 'node:timers/promises';

import type { Clock } from '../../../ports/clock';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    // An aborted wait is not an error for the caller: it just checks the signal and stops (D33).
    await delay(milliseconds, undefined, { signal }).catch((error: unknown) => {
      if (!signal?.aborted) throw error;
    });
  }
}
