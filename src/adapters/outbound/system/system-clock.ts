import { setTimeout as delay } from 'node:timers/promises';

import type { Clock } from '../../../ports/clock';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(milliseconds: number): Promise<void> {
    await delay(milliseconds);
  }
}
