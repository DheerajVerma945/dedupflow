/**
 * dedup.ts — Deduplication Engine with TTL Cache
 *
 * Wraps an async function so that:
 *  1. Concurrent calls with the same key share one in-flight promise.
 *  2. Completed results are optionally cached with a TTL expiry.
 *  3. Failed executions are never cached and in-flight entries are cleaned up.
 *  4. Cache size is optionally bounded; oldest entries are evicted first (FIFO).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by createDedup. */
export interface DedupOptions<TArgs extends unknown[]> {
  /**
   * Time-to-live for cached results in milliseconds.
   * If omitted, results live until manually cleared or the dedup instance is
   * garbage-collected.
   */
  ttl?: number;

  /**
   * Whether to cache successful results at all.
   * Defaults to true.
   */
  cache?: boolean;

  /**
   * Derives a string cache key from the function arguments.
   * Defaults to JSON.stringify(args).
   * NOTE: JSON.stringify is not safe for circular or non-serialisable objects.
   * Provide a custom key function when working with complex argument types.
   */
  key?: (...args: TArgs) => string;

  /**
   * Maximum number of entries the cache may hold at one time.
   * When the limit is reached, the oldest entry is evicted before a new one
   * is inserted (FIFO eviction).  Works alongside TTL expiry.
   * Omit for an unbounded cache.
   */
  maxSize?: number;
}

/** Per-call options that can override dedup behaviour for a single invocation. */
export interface CallOptions {
  /**
   * When true the dedup and cache layers are bypassed entirely for this call.
   * The underlying function is always executed fresh.
   */
  force?: boolean;
}

/** A wrapped function that behaves like the original but with dedup/cache. */
export type DedupFunction<TArgs extends unknown[], TResult> = {
  (...args: TArgs): Promise<TResult>;

  /**
   * Call the original function directly, bypassing all dedup/cache logic.
   * Useful for intentional cache-busting or internal tooling.
   */
  raw(...args: TArgs): Promise<TResult>;

  /**
   * Force a fresh execution even if an in-flight request exists or a cached
   * result is available.  Evicts the existing entry before executing.
   */
  force(...args: TArgs): Promise<TResult>;

  /**
   * @deprecated Use `force` instead.
   */
  forceCall(...args: TArgs): Promise<TResult>;

  /** Remove all cached entries immediately. */
  clearCache(): void;
};

// ---------------------------------------------------------------------------
// Internal cache entry shape
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  /** Absolute timestamp (Date.now()) after which this entry is considered stale. */
  expiresAt: number | null; // null → never expires
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Wraps `fn` with in-flight deduplication and optional TTL caching.
 *
 * @param fn       The async (or sync) function to wrap.
 * @param options  Dedup / cache configuration.
 */
export function createDedup<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  options?: DedupOptions<TArgs>
): DedupFunction<TArgs, TResult> {

  const shouldCache = options?.cache !== false; // default: true
  const ttl = options?.ttl;
  const maxSize = options?.maxSize;

  // Default key uses JSON.stringify with a safe fallback for non-serialisable
  // arguments.  Provide a custom `key` function for complex or circular objects.
  const defaultKey = (...args: TArgs): string => {
    try {
      return JSON.stringify(args);
    } catch {
      throw new TypeError(
        "dedupflow: Failed to serialize arguments to a cache key. " +
        "Provide a custom `key` function via the options parameter."
      );
    }
  };

  // Derive a string key from the call arguments.
  const getKey: (...args: TArgs) => string = options?.key ?? defaultKey;

  // Map from cache key → in-flight promise (for deduplication).
  const inFlight = new Map<string, Promise<TResult>>();

  // Map from cache key → cached result (for TTL cache).
  // Map insertion order is preserved in JavaScript, enabling FIFO eviction.
  const cache = new Map<string, CacheEntry<TResult>>();

  // ---------------------------------------------------------------------------
  // Periodic cache cleanup
  //
  // Run cleanup every `ttl / 2` ms, clamped between MIN_CLEANUP_INTERVAL_MS
  // and MAX_CLEANUP_INTERVAL_MS.  Only scheduled when a TTL is configured AND
  // caching is enabled.  A single interval is created per dedup instance.
  // ---------------------------------------------------------------------------
  const MIN_CLEANUP_INTERVAL_MS = 500;
  const MAX_CLEANUP_INTERVAL_MS = 60_000;

  if (shouldCache && ttl != null) {
    const cleanupInterval = Math.min(
      Math.max(Math.floor(ttl / 2), MIN_CLEANUP_INTERVAL_MS),
      MAX_CLEANUP_INTERVAL_MS
    );

    const cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, entry] of cache) {
        if (entry.expiresAt !== null && now >= entry.expiresAt) {
          cache.delete(k);
        }
      }
    }, cleanupInterval);

    // Allow the Node.js process to exit even if the interval is still active.
    if (cleanupTimer.unref) {
      cleanupTimer.unref();
    }
  }

  // ---------------------------------------------------------------------------
  // Core execution — shared by the main callable and force
  // ---------------------------------------------------------------------------

  /**
   * Execute `fn` with the given args, managing in-flight dedup and cache.
   *
   * @param args        Arguments forwarded to the wrapped function.
   * @param bypassDedup When true, skip dedup/cache and always call fn fresh.
   */
  function execute(args: TArgs, bypassDedup: boolean): Promise<TResult> {
    const key = getKey(...args);

    if (!bypassDedup) {
      // 1. Return cached result if available and not expired.
      if (shouldCache) {
        const cached = cache.get(key);
        if (cached !== undefined) {
          const now = Date.now();
          if (cached.expiresAt === null || now < cached.expiresAt) {
            return Promise.resolve(cached.value);
          }
          // Expired — evict immediately before proceeding.
          cache.delete(key);
        }
      }

      // 2. Return existing in-flight promise for the same key (deduplication).
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        return existing;
      }
    }

    // 3. No hit — execute the function.
    // Wrap in Promise.resolve().then() to safely handle synchronous functions
    // and synchronous throws as Promise rejections.
    const promise = (Promise.resolve().then(() => fn(...args)) as Promise<TResult>)
      .then((result) => {
        // Remove from in-flight map as soon as we have a result.
        inFlight.delete(key);

        // Store in cache if caching is enabled.
        if (shouldCache) {
          // Enforce maxSize by evicting the oldest entry (FIFO) before inserting.
          if (maxSize != null && cache.size >= maxSize) {
            cache.delete(cache.keys().next().value!);
          }

          const expiresAt = ttl != null ? Date.now() + ttl : null;
          cache.set(key, { value: result, expiresAt });
        }

        return result;
      })
      .catch((err: unknown) => {
        // On failure: remove in-flight entry so the next call retries.
        // Do NOT cache the failure.
        inFlight.delete(key);
        throw err;
      });

    // Register the in-flight promise so concurrent callers can share it.
    if (!bypassDedup) {
      inFlight.set(key, promise);
    }

    return promise;
  }

  // ---------------------------------------------------------------------------
  // Public callable
  // ---------------------------------------------------------------------------

  const dedupFn = function (...args: TArgs): Promise<TResult> {
    return execute(args, false);
  } as DedupFunction<TArgs, TResult>;

  /** Bypass dedup and cache entirely — always calls the original function. */
  dedupFn.raw = function (...args: TArgs): Promise<TResult> {
    return Promise.resolve().then(() => fn(...args)) as Promise<TResult>;
  };

  /**
   * Force a fresh execution even if dedup/cache would normally short-circuit.
   * Evicts any existing in-flight or cached entry for this key first.
   */
  dedupFn.force = function (...args: TArgs): Promise<TResult> {
    const key = getKey(...args);
    // Evict any stale in-flight or cached entry for this key first.
    inFlight.delete(key);
    cache.delete(key);
    return execute(args, false);
  };

  /** @deprecated Use `force` instead. */
  dedupFn.forceCall = dedupFn.force;

  /** Clear all cached results immediately. */
  dedupFn.clearCache = function (): void {
    cache.clear();
  };

  return dedupFn;
}
