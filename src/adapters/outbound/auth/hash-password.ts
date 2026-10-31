import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { hashPassword } from './password-hasher';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * `pnpm hash-password`: reads a password (hidden when typed in a terminal) and prints its argon2id hash,
 * to be stored in operator_accounts.password_hash by the deployment team. The password is never printed.
 */
async function readPassword(prompt: string): Promise<string> {
  const interactive = process.stdin.isTTY === true;
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: interactive });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      if (interactive) process.stderr.write('\n');
      resolve(answer);
    });
    muted = interactive;
  });
}

async function main(): Promise<void> {
  const password = await readPassword('Password: ');
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    process.stderr.write(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.\n`);
    process.exitCode = 1;
    return;
  }
  if (process.stdin.isTTY === true && (await readPassword('Repeat password: ')) !== password) {
    process.stderr.write('The passwords do not match.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
}

void main();
