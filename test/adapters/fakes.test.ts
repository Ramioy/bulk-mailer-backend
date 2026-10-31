import { describe, expect, it } from 'vitest';

import { FakeAuthenticator } from '../../src/adapters/outbound/fakes/fake-authenticator';
import { FakeContractSource } from '../../src/adapters/outbound/fakes/fake-contract-source';
import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { FakeFileInspector } from '../../src/adapters/outbound/fakes/fake-file-inspector';
import { FakeSuppressionManager } from '../../src/adapters/outbound/fakes/fake-suppression-manager';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { EnvSecretStore } from '../../src/adapters/outbound/system/env-secret-store';
import { MissingSecretError } from '../../src/ports/secret-store';

const email = (attemptId: string) => ({
  attemptId,
  to: 'a@x.co',
  subject: 's',
  textBody: 'b',
  attachment: { name: 'a.pdf', content: new Uint8Array([1]) },
});

describe('FakeEmailProvider', () => {
  it('answers the scripted outcomes in order, then accepts', async () => {
    const provider = new FakeEmailProvider().respondWith(
      { kind: 'UNCERTAIN', detail: 'timeout' },
      (e) => ({ kind: 'RECEIPT_REJECTED', detail: `bad ${e.to}` }),
    );
    expect(await provider.send(email('1'))).toEqual({ kind: 'UNCERTAIN', detail: 'timeout' });
    expect(await provider.send(email('2'))).toEqual({ kind: 'RECEIPT_REJECTED', detail: 'bad a@x.co' });
    expect(await provider.send(email('3'))).toEqual({ kind: 'ACCEPTED', providerRequestId: 'fake-3' });
    expect(provider.calls.map((c) => c.attemptId)).toEqual(['1', '2', '3']);
  });
});

describe('FakeContractSource', () => {
  it('answers found, not found and unavailable', async () => {
    const source = new FakeContractSource({ '1': { complexName: 'Altos', email: 'a@x.co' } });
    expect(await source.get('1')).toEqual({ kind: 'FOUND', contract: '1', active: true, complexName: 'Altos', email: 'a@x.co' });
    expect(await source.get('2')).toEqual({ kind: 'NOT_FOUND' });
    source.setUnavailable(true);
    expect((await source.get('1')).kind).toBe('UNAVAILABLE');
  });
});

describe('FakeFileInspector', () => {
  it('accepts by default and rejects configured content', async () => {
    const inspector = new FakeFileInspector();
    inspector.rejectContent(new Uint8Array([9]), { ok: false, error: 'NOT_A_PDF' });
    expect(await inspector.inspect(new Uint8Array([1]))).toEqual({ ok: true });
    expect(await inspector.inspect(new Uint8Array([9]))).toEqual({ ok: false, error: 'NOT_A_PDF' });
  });
});

describe('FakeSuppressionManager', () => {
  it('releases suppressed addresses and fails closed when configured', async () => {
    const manager = new FakeSuppressionManager();
    manager.suppress('a@x.co');
    expect(await manager.release('a@x.co')).toEqual({ ok: true, value: 'RELEASED' });
    expect(await manager.release('a@x.co')).toEqual({ ok: true, value: 'NOT_SUPPRESSED' });
    manager.failWith('scope missing');
    expect(await manager.release('a@x.co')).toEqual({ ok: false, error: 'scope missing' });
  });
});

describe('FakeAuthenticator', () => {
  it('distinguishes unknown user and wrong password; tokens expire', async () => {
    const clock = new FixedClock();
    const auth = new FakeAuthenticator({ op: 'secret' }, clock);
    expect(await auth.signIn('nobody', 'x')).toEqual({ ok: false, error: 'UNKNOWN_USER' });
    expect(await auth.signIn('op', 'x')).toEqual({ ok: false, error: 'WRONG_PASSWORD' });

    const signedIn = await auth.signIn('op', 'secret');
    if (!signedIn.ok) throw new Error('sign-in failed');
    const { accessToken, refreshToken, refreshExpiresAt } = signedIn.value.tokens;
    expect(await auth.verify(accessToken)).toEqual({ ok: true, value: { operatorId: 'op', username: 'op' } });

    clock.advance(15 * 60_000);
    expect(await auth.verify(accessToken)).toEqual({ ok: false, error: 'INVALID_ACCESS_TOKEN' });

    const refreshed = await auth.refresh(refreshToken);
    expect(refreshed.ok && refreshed.value.tokens.refreshExpiresAt).toEqual(refreshExpiresAt);
    expect(await auth.refresh(refreshToken)).toEqual({ ok: false, error: 'INVALID_REFRESH_TOKEN' });
  });
});

describe('FixedClock', () => {
  it('only moves when told to; sleep advances and is recorded', async () => {
    const clock = new FixedClock('2026-10-15T15:00:00Z');
    await clock.sleep(30_000);
    expect(clock.now().toISOString()).toBe('2026-10-15T15:00:30.000Z');
    expect(clock.sleeps).toEqual([30_000]);
  });
});

describe('EnvSecretStore', () => {
  it('reads present secrets and refuses missing or empty ones', async () => {
    const store = new EnvSecretStore({ ZEPTOMAIL_API_KEY: 'k', EMPTY: '' });
    expect(await store.get('ZEPTOMAIL_API_KEY')).toBe('k');
    await expect(store.get('EMPTY')).rejects.toBeInstanceOf(MissingSecretError);
    await expect(store.get('NOPE')).rejects.toBeInstanceOf(MissingSecretError);
  });
});
