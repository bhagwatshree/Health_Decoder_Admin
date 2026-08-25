/**
 * Tiny in-memory TTL cache for the summary payload.
 *
 * Every /api/summary miss fans out to ~15 DB queries plus CloudWatch GetMetricData,
 * which is billed per metric ($0.01/1,000) and excluded from the CloudWatch free tier.
 * Caching keeps a browser refresh — or a second viewer — from re-paying for it.
 *
 * In-process only: on a scale-to-zero host each container keeps its own copy, which is
 * fine here since the cache is an optimization, not a source of truth.
 */
export function createTtlCache(ttlMs) {
  const entries = new Map(); // key -> { value, expiresAt }
  const inFlight = new Map(); // key -> Promise, dedupes concurrent misses

  return {
    /** Returns the cached value for `key`, else calls `produce()` and caches its result. */
    async get(key, produce) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > Date.now()) {
        return { value: hit.value, cached: true, cachedAt: hit.cachedAt };
      }

      const pending = inFlight.get(key);
      if (pending) return { value: await pending, cached: false, cachedAt: new Date().toISOString() };

      const promise = produce();
      inFlight.set(key, promise);
      try {
        const value = await promise;
        const cachedAt = new Date().toISOString();
        entries.set(key, { value, cachedAt, expiresAt: Date.now() + ttlMs });
        return { value, cached: false, cachedAt };
      } finally {
        // Failures are never cached — the next request retries.
        inFlight.delete(key);
      }
    },
  };
}
