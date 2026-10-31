import { describe, expect, it } from 'vitest';

import { logRecipients } from '../../src/adapters/outbound/zeptomail/log-recipients';
import { ZeptoMailSendLookup } from '../../src/adapters/outbound/zeptomail/zeptomail-send-lookup';
import { ZohoOAuthTokenProvider } from '../../src/adapters/outbound/zeptomail/zoho-oauth';

const ATTEMPT = 'att-1';
const TO = 'admin@altos.com';

describe('logRecipients (D35): every shape of "to" ZeptoMail may use', () => {
  it.each([
    ['plain address', 'admin@altos.com', ['admin@altos.com']],
    ['upper case and spaces', '  Admin@Altos.COM ', ['admin@altos.com']],
    ['name and address', 'Edificio Altos <Admin@altos.com>', ['admin@altos.com']],
    ['email_address object', { email_address: { address: 'admin@altos.com', name: 'Altos' } }, ['admin@altos.com']],
    ['address object', { address: 'admin@altos.com' }, ['admin@altos.com']],
    ['email object', { email: 'ADMIN@altos.com' }, ['admin@altos.com']],
    ['array of mixed shapes', ['Copy <archivo@anutibara.com>', { email_address: { address: 'admin@altos.com' } }], ['archivo@anutibara.com', 'admin@altos.com']],
    ['nested array', [[{ address: 'admin@altos.com' }]], ['admin@altos.com']],
  ] as const)('%s', (_name, to, expected) => {
    expect(logRecipients(to)).toEqual(expected);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
    ['not an address', 'Edificio Altos'],
    ['an object without address', { name: 'Altos' }],
    ['an empty array', []],
    ['an array of unreadable items', [{ name: 'x' }, 7]],
  ] as const)('reads nothing from %s', (_name, to) => {
    expect(logRecipients(to)).toEqual([]);
  });
});

type Route = (url: URL) => Response;

/** The lookup over a scripted logs API: `list` answers `GET /email`, `detail` answers `GET /email/email-reference/{ref}`. */
function lookupWith(list: Route, detail: Route = () => Response.json({ data: { client_reference: ATTEMPT, status: 'delivered', request_id: 'req-1' } })) {
  const calls: string[] = [];
  const api: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    return url.pathname.includes('/email-reference/') ? detail(url) : list(url);
  };
  const oauth: typeof fetch = async () => Response.json({ access_token: 'token', expires_in: 3600 });
  const tokens = new ZohoOAuthTokenProvider({ accountsUrl: 'https://accounts.test', clientId: 'c', clientSecret: 's', refreshToken: 'r', timeoutMs: 1000, fetch: oauth });
  return { lookup: new ZeptoMailSendLookup({ baseUrl: 'https://logs.test/v1.1', timeoutMs: 1000, fetch: api }, tokens), calls };
}

const listOf = (...data: unknown[]): Route => () => Response.json({ data, status: 'success' });

describe('ZeptoMailSendLookup never answers NOT_FOUND for what it could not read (D35)', () => {
  it('NOT_FOUND for EL_404 and for an empty list', async () => {
    const el404 = lookupWith(() => Response.json({ error: { code: 'EL_404', message: 'not found' } }, { status: 400 }));
    expect(await el404.lookup.findByAttempt(ATTEMPT, TO)).toEqual({ kind: 'NOT_FOUND' });
    expect(await lookupWith(listOf()).lookup.findByAttempt(ATTEMPT, TO)).toEqual({ kind: 'NOT_FOUND' });
  });

  it.each([
    ['plain', TO],
    ['name and address', `Edificio Altos <${TO}>`],
    ['email_address object', { email_address: { address: TO } }],
    ['array with the copy', [{ address: 'archivo@anutibara.com' }, { email: TO.toUpperCase() }]],
  ] as const)('finds the entry with "to" as %s', async (_name, to) => {
    const { lookup } = lookupWith(listOf({ email_reference: 'ref-1', to }));
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toEqual({ kind: 'FOUND', status: 'DELIVERED', providerRequestId: 'req-1', emailReference: 'ref-1', detail: 'delivered' });
  });

  it.each([
    ['"to" unreadable', listOf({ email_reference: 'ref-1', to: { name: 'Altos' } }), undefined],
    ['"to" unreadable', listOf({ email_reference: 'ref-1', to: undefined }), undefined],
    ['none for the recipient', listOf({ email_reference: 'ref-1', to: 'otro@altos.com' }), undefined],
    ['email_reference missing', listOf({ to: TO }), undefined],
    ['email_reference missing', listOf({ to: TO, email_reference: 7 }), undefined],
    ['detail not found', listOf({ to: TO, email_reference: 'ref-1' }), () => Response.json({ error: { code: 'EL_404' } }, { status: 404 })],
    ['detail without client_reference', listOf({ to: TO, email_reference: 'ref-1' }), () => Response.json({ data: { status: 'delivered' } })],
  ] as const)('UNAVAILABLE when no entry is usable: %s', async (reason, list, detail) => {
    const { lookup } = lookupWith(list, detail);
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toEqual({
      kind: 'UNAVAILABLE',
      detail: `logs API: 1 entries for the reference, none usable: ${reason === 'none for the recipient' ? `none for ${TO}` : reason}`,
    });
  });

  it('lists every reason when several entries are unusable, and still finds a usable one among them', async () => {
    const unusable = lookupWith(listOf({ to: 'Altos' }, { to: TO }, { to: 'archivo@anutibara.com', email_reference: 'ref-copy' }));
    expect(await unusable.lookup.findByAttempt(ATTEMPT, TO)).toEqual({
      kind: 'UNAVAILABLE',
      detail: 'logs API: 3 entries for the reference, none usable: "to" unreadable; email_reference missing',
    });
    // The copy's entry is never looked up in detail.
    expect(unusable.calls.filter((c) => c.includes('email-reference'))).toEqual([]);

    const mixed = lookupWith(listOf({ to: 'Altos' }, { to: TO, email_reference: 'ref-2' }));
    expect(await mixed.lookup.findByAttempt(ATTEMPT, TO)).toMatchObject({ kind: 'FOUND', emailReference: 'ref-2' });
  });

  it('NOT_FOUND when every entry of the recipient is confirmed to be another send (partial match of the reference)', async () => {
    const { lookup } = lookupWith(listOf({ to: TO, email_reference: 'ref-other' }), () => Response.json({ data: { client_reference: `${ATTEMPT}-other`, status: 'delivered' } }));
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('...but UNAVAILABLE if, besides another send, an entry could not be read', async () => {
    const { lookup } = lookupWith(listOf({ to: TO, email_reference: 'ref-other' }, { to: TO }), () => Response.json({ data: { client_reference: 'other', status: 'delivered' } }));
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toMatchObject({ kind: 'UNAVAILABLE', detail: expect.stringContaining('email_reference missing') });
  });

  it.each([
    ['has_more', { has_more: true }],
    ['total', { total: 40 }],
    ['next_offset', { next_offset: 25 }],
    ['page_info.has_more', { page_info: { has_more: true } }],
  ] as const)('UNAVAILABLE when the list says there is more than one page (%s)', async (_name, extra) => {
    const { lookup, calls } = lookupWith(() => Response.json({ data: [{ to: 'otro@altos.com', email_reference: 'r' }], status: 'success', ...extra }));
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toMatchObject({ kind: 'UNAVAILABLE', detail: expect.stringContaining('not guessing from one page') });
    expect(calls).toHaveLength(1);
  });

  it('a total equal to the page is not "more"', async () => {
    const { lookup } = lookupWith(() => Response.json({ data: [{ to: TO, email_reference: 'r' }], total: 1 }));
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toMatchObject({ kind: 'FOUND' });
  });

  it('an entry that is not an object is unusable, not a crash', async () => {
    const { lookup } = lookupWith(listOf(null, 'x'));
    expect(await lookup.findByAttempt(ATTEMPT, TO)).toEqual({ kind: 'UNAVAILABLE', detail: 'logs API: 2 entries for the reference, none usable: "to" unreadable' });
  });
});
