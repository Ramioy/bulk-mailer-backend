import type { SerialExecutor } from '../../src/application/shared/serial-executor';

/**
 * D36 guard rail: records every call to an external port fake made while the serial executor runs a command.
 * The executor and the fakes are patched in place, so every use case built on them is observed.
 */
export function guardExternalCalls(serial: SerialExecutor, targets: ReadonlyArray<readonly [label: string, target: object, methods: readonly string[]]>): string[] {
  const violations: string[] = [];
  let busy = 0;
  const run = serial.run.bind(serial);
  serial.run = <T>(command: () => Promise<T>): Promise<T> =>
    run(async () => {
      busy += 1;
      try {
        return await command();
      } finally {
        busy -= 1;
      }
    });
  for (const [label, target, methods] of targets) {
    const object = target as Record<string, (...args: unknown[]) => unknown>;
    for (const method of methods) {
      const original = object[method]?.bind(target);
      if (!original) throw new Error(`${label} has no method ${method}`);
      object[method] = (...args: unknown[]) => {
        if (busy > 0) violations.push(`${label}.${method}`);
        return original(...args);
      };
    }
  }
  return violations;
}

/** A promise opened and released by the test, to hold an external call in flight. */
export function gate(): { readonly wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
