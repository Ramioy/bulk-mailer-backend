import { normaliseEmail } from '../../../domain/recipient/recipient';

/**
 * Addresses of the `to` field of a ZeptoMail log entry, normalised (D27). Its shape is not documented for the logs
 * API (§12.7), so every shape ZeptoMail uses elsewhere is accepted: `"addr"`, `"Name <addr>"`,
 * `{ email_address: { address } }`, `{ address }`, `{ email }`, or an array of any of those. Whatever cannot be read
 * is left out; an empty result means the field could not be read at all (D35).
 */
export function logRecipients(to: unknown): string[] {
  if (Array.isArray(to)) return to.flatMap((item) => logRecipients(item));
  const address = addressOf(to);
  return address ? [address] : [];
}

function addressOf(value: unknown): string | undefined {
  if (typeof value === 'string') return fromText(value);
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.email_address === 'object' && record.email_address !== null) return addressOf(record.email_address);
  if (typeof record.address === 'string') return fromText(record.address);
  if (typeof record.email === 'string') return fromText(record.email);
  return undefined;
}

/** `addr` or `Name <addr>`; anything without exactly one `@` is not an address. */
function fromText(text: string): string | undefined {
  const angled = /<([^<>]+)>\s*$/.exec(text);
  const candidate = normaliseEmail(angled ? (angled[1] ?? '') : text);
  return /^[^\s@<>]+@[^\s@<>]+$/.test(candidate) ? candidate : undefined;
}
