import { describe, expect, it } from 'vitest';

import { InstanceCoordinator, type LeaderWork } from '../../src/adapters/inbound/jobs/instance-coordinator';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryInstanceLease } from '../../src/adapters/outbound/in-memory/in-memory-instance-lease';
import type { InstanceLease } from '../../src/ports/instance-lease';
import { startTestApp, TEST_PASSWORD } from '../support/test-app';

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

/** What an instance did, in order. */
function recording(name: string, log: string[]): LeaderWork {
  return {
    recover: async () => void log.push(`${name}:recover`),
    start: () => void log.push(`${name}:start`),
    stop: async () => void log.push(`${name}:stop`),
  };
}

describe('InstanceCoordinator (D47)', () => {
  it('a second instance stands by while the first holds the lease, and takes over (with recovery) once it expires', async () => {
    const clock = new FixedClock();
    const lease = new InMemoryInstanceLease(() => clock.now());
    const log: string[] = [];
    const a = new InstanceCoordinator(lease, 'a', 30, recording('a', log), silent);
    const b = new InstanceCoordinator(lease, 'b', 30, recording('b', log), silent);

    expect(await a.tick()).toBe('leader');
    expect(await b.tick()).toBe('standby');
    // a renews every 10 s; b keeps asking.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(10_000);
      expect(await a.tick()).toBe('leader');
      expect(await b.tick()).toBe('standby');
    }
    expect(log).toEqual(['a:recover', 'a:start']);

    // a stops renewing (frozen, cut off): its lease expires, b takes over and recovers once.
    clock.advance(31_000);
    expect(await b.tick()).toBe('leader');
    expect(await b.tick()).toBe('leader');
    expect(log).toEqual(['a:recover', 'a:start', 'b:recover', 'b:start']);
    // a comes back: its renewal fails, it stops its work and stands by.
    expect(await a.tick()).toBe('standby');
    expect(log.at(-1)).toBe('a:stop');
    expect(await lease.current()).toMatchObject({ holder: 'b', live: true });
  });

  it('a leader that cannot reach the lease stops its work at once and stands by', async () => {
    const clock = new FixedClock();
    const inner = new InMemoryInstanceLease(() => clock.now());
    let down = false;
    const lease: InstanceLease = {
      acquire: (id, ttl) => (down ? Promise.reject(new Error('ECONNREFUSED')) : inner.acquire(id, ttl)),
      renew: (id, ttl) => (down ? Promise.reject(new Error('ECONNREFUSED')) : inner.renew(id, ttl)),
      release: (id) => inner.release(id),
      current: () => inner.current(),
    };
    const log: string[] = [];
    const a = new InstanceCoordinator(lease, 'a', 30, recording('a', log), silent);
    expect(await a.tick()).toBe('leader');
    down = true;
    clock.advance(10_000);
    expect(await a.tick()).toBe('standby');
    expect(log).toEqual(['a:recover', 'a:start', 'a:stop']);
    expect(await a.tick()).toBe('standby');
    // The database is back: it holds the lease again (it was still its own) and recovers again.
    down = false;
    expect(await a.tick()).toBe('leader');
    expect(log).toEqual(['a:recover', 'a:start', 'a:stop', 'a:recover', 'a:start']);
  });

  it('on shutdown the leader stops its work, then releases the lease so another instance can take it at once', async () => {
    const clock = new FixedClock();
    const lease = new InMemoryInstanceLease(() => clock.now());
    const log: string[] = [];
    const a = new InstanceCoordinator(lease, 'a', 30, recording('a', log), silent);
    const b = new InstanceCoordinator(lease, 'b', 30, recording('b', log), silent);
    await a.tick();
    await b.tick();
    await a.end();
    expect(await b.tick()).toBe('leader');
    expect(log).toEqual(['a:recover', 'a:start', 'a:stop', 'b:recover', 'b:start']);
  });

  it('a recovery that fails gives the lease up and starts nothing', async () => {
    const clock = new FixedClock();
    const lease = new InMemoryInstanceLease(() => clock.now());
    const started: string[] = [];
    const a = new InstanceCoordinator(lease, 'a', 30, { recover: () => Promise.reject(new Error('db')), start: () => void started.push('a'), stop: async () => undefined }, silent);
    expect(await a.tick()).toBe('standby');
    expect(started).toEqual([]);
    expect(await lease.current()).toMatchObject({ live: false });
  });
});

describe('GET /instance and two app instances on one lease (D47)', () => {
  it('the first app leads, the second stands by and serves HTTP only', async () => {
    const shared = new InMemoryInstanceLease();
    const first = await startTestApp({ JOB_RUNNER_ENABLED: 'true' }, { adapters: { instanceLease: shared } });
    const second = await startTestApp({ JOB_RUNNER_ENABLED: 'true' }, { adapters: { instanceLease: shared } });
    try {
      const status = async (ctx: typeof first) => {
        const token = (await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username: 'operador', password: TEST_PASSWORD } })).json().accessToken;
        return ctx.app.inject({ method: 'GET', url: '/instance', headers: { authorization: `Bearer ${token}` } });
      };
      const leader = (await status(first)).json();
      const standby = (await status(second)).json();
      expect(leader).toMatchObject({ role: 'leader', leaseHolder: leader.instanceId });
      expect(standby).toMatchObject({ role: 'standby', leaseHolder: leader.instanceId });
      expect(standby.instanceId).not.toBe(leader.instanceId);
      expect((await first.app.inject({ method: 'GET', url: '/instance' })).statusCode).toBe(401);
    } finally {
      await second.app.close();
      await first.app.close();
    }
    // Released on shutdown.
    expect(await shared.current()).toMatchObject({ live: false });
  });
});
