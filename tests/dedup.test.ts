import { createDedup } from "../src/dedup";

// Advance timers in tests that rely on TTL expiry
jest.useFakeTimers();

describe("createDedup — in-flight deduplication", () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  test("concurrent identical calls share one execution", async () => {
    let callCount = 0;
    const fn = jest.fn(async (id: number) => {
      callCount++;
      return { id };
    });

    const dedupFn = createDedup(fn);

    const [r1, r2] = await Promise.all([dedupFn(1), dedupFn(1)]);
    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 1 });
    expect(callCount).toBe(1);
  });

  test("different keys execute independently", async () => {
    let callCount = 0;
    const fn = jest.fn(async (id: number) => {
      callCount++;
      return { id };
    });

    const dedupFn = createDedup(fn);

    const [r1, r2] = await Promise.all([dedupFn(1), dedupFn(2)]);
    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 2 });
    expect(callCount).toBe(2);
  });

  test("failed call clears in-flight entry so next call retries", async () => {
    let attempt = 0;
    const fn = jest.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("first failure");
      return "ok";
    });

    const dedupFn = createDedup(fn, { cache: false });

    await expect(dedupFn()).rejects.toThrow("first failure");
    const result = await dedupFn();
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("createDedup — TTL cache", () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  test("cached result returned within TTL", async () => {
    const fn = jest.fn(async (id: number) => ({ id }));
    const dedupFn = createDedup(fn, { ttl: 1000 });

    const r1 = await dedupFn(1);
    // Second call within TTL should hit cache.
    const r2 = await dedupFn(1);

    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("expired cache entry causes re-execution", async () => {
    const fn = jest.fn(async (id: number) => ({ id }));
    const dedupFn = createDedup(fn, { ttl: 500 });

    await dedupFn(1);
    // Advance time past TTL.
    jest.advanceTimersByTime(600);

    await dedupFn(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("cache: false skips caching but still deduplicates in-flight", async () => {
    const fn = jest.fn(async (id: number) => ({ id }));
    const dedupFn = createDedup(fn, { cache: false });

    await dedupFn(1);
    await dedupFn(1); // sequential — no in-flight dedup, no cache
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("clearCache forces re-execution", async () => {
    const fn = jest.fn(async (id: number) => ({ id }));
    const dedupFn = createDedup(fn, { ttl: 10_000 });

    await dedupFn(1);
    dedupFn.clearCache();
    await dedupFn(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("createDedup — raw and forceCall", () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  test("raw() bypasses dedup and cache entirely", async () => {
    const fn = jest.fn(async (id: number) => ({ id }));
    const dedupFn = createDedup(fn, { ttl: 10_000 });

    await dedupFn(1); // populates cache
    await dedupFn.raw(1); // should still call fn
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("forceCall() ignores cache and starts fresh execution", async () => {
    const fn = jest.fn(async (id: number) => ({ id }));
    const dedupFn = createDedup(fn, { ttl: 10_000 });

    await dedupFn(1); // populates cache
    await dedupFn.forceCall(1); // should bypass cache
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("createDedup — custom key function", () => {
  test("custom key groups calls correctly", async () => {
    const fn = jest.fn(async (user: { id: number }) => user.id);
    const dedupFn = createDedup(fn, {
      key: (user) => String(user.id),
    });

    const [r1, r2] = await Promise.all([
      dedupFn({ id: 1 }),
      dedupFn({ id: 1 }),
    ]);
    expect(r1).toBe(1);
    expect(r2).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createDedup — integration with createPool", () => {
  test("pool + dedup: duplicate tasks share one execution", async () => {
    const { createPool } = await import("../src/pool");

    const fn = jest.fn(async (id: number) => ({ id }));
    const cachedFetch = createDedup(fn, { ttl: 5000 });
    const pool = createPool({ limit: 3 });

    const results = await pool.run([
      () => cachedFetch(1),
      () => cachedFetch(1),
      () => cachedFetch(2),
    ]);

    expect(results).toEqual([{ id: 1 }, { id: 1 }, { id: 2 }]);
    // cachedFetch(1) called twice but fn should be called only once for id=1
    // and once for id=2.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
