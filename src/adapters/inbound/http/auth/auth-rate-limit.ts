import type { FastifyInstance } from 'fastify';

/**
 * D50 (B5): a fixed one-minute window per client IP on the public auth routes. Accounts are never locked (§15): an
 * attacker is slowed down instead, and the audit table does not fill up with their attempts. In memory, for the single
 * instance; a restart resets it.
 */
export function registerAuthRateLimit(app: FastifyInstance, perMinute: number, now: () => number = Date.now): void {
  const windows = new Map<string, { start: number; count: number }>();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/auth/')) return;
    const at = now();
    const key = request.ip;
    let window = windows.get(key);
    if (!window || at - window.start >= 60_000) {
      window = { start: at, count: 0 };
      windows.set(key, window);
      // Old windows are forgotten as they are replaced; a sweep keeps the map from growing with one-off clients.
      if (windows.size > 10_000) for (const [ip, w] of windows) if (at - w.start >= 60_000) windows.delete(ip);
    }
    window.count += 1;
    if (window.count > perMinute) {
      const retryAfter = Math.ceil((window.start + 60_000 - at) / 1000);
      await reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'TOO_MANY_REQUESTS', retryAfterSeconds: retryAfter });
    }
  });
}
