# dedupflow

[![npm version](https://img.shields.io/npm/v/dedupflow.svg)](https://www.npmjs.com/package/dedupflow)
[![license](https://img.shields.io/npm/l/dedupflow.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D14-339933.svg)](https://nodejs.org/)

A lightweight, production-ready async execution control library for Node.js with **zero external dependencies**.

`dedupflow` gives you three composable primitives that solve the most common async coordination problems without the complexity of a full job-queue framework:

| Primitive | What it solves |
|---|---|
| **Concurrency Pool** | Limit how many async tasks run simultaneously, with retries and cancellation |
| **In-flight Deduplication** | Collapse concurrent calls with the same key into a single execution |
| **TTL Cache** | Remember results in memory with automatic expiry and optional size cap |

---

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [createPool](#createpool)
  - [pool.run](#poolrun)
  - [createDedup](#creatededup)
  - [Dedup methods](#dedup-methods)
- [Behaviour In Depth](#behaviour-in-depth)
  - [Concurrency and fail-fast](#concurrency-and-fail-fast)
  - [Timeout](#timeout)
  - [Retries](#retries)
  - [Abort and cancellation](#abort-and-cancellation)
  - [Timeout and retry interaction](#timeout-and-retry-interaction)
  - [In-flight deduplication](#in-flight-deduplication)
  - [TTL cache](#ttl-cache)
  - [Cache key generation](#cache-key-generation)
- [Examples](#examples)
- [Edge Cases](#edge-cases)
- [Limitations](#limitations)
- [Design Principles](#design-principles)
- [Project Structure](#project-structure)
- [License](#license)

---

## Installation

```bash
npm install dedupflow
```

```bash
yarn add dedupflow
```

---

## Quick Start

```ts
import { createPool, createDedup } from 'dedupflow';

// At most 3 concurrent HTTP requests, with retries on failure
const pool = createPool({ limit: 3, retries: 2, retryDelay: 500 });

// Wrap fetch with deduplication + 5-second TTL cache
const fetchUser = async (id: number) => {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
};
const cachedFetch = createDedup(fetchUser, { ttl: 5_000 });

const results = await pool.run([
  () => cachedFetch(1),
  () => cachedFetch(1), // deduplicated — shares the same in-flight request
  () => cachedFetch(2),
]);
// fetchUser is called exactly twice (once per unique id)
```

---

## API Reference

### `createPool`

```ts
import { createPool } from 'dedupflow';

const pool = createPool(options?: PoolOptions): Pool;
```

Creates a reusable concurrency pool. All options are optional.

```ts
interface PoolOptions {
  limit?:      number;       // default: 5
  timeout?:    number;       // default: undefined (no timeout)
  retries?:    number;       // default: 0
  retryDelay?: number;       // default: 0
  signal?:     AbortSignal;  // default: undefined (no cancellation)
}
```

| Option | Type | Default | Constraint | Description |
|---|---|---|---|---|
| `limit` | `number` | `5` | `>= 1` | Maximum number of tasks that may run concurrently. |
| `timeout` | `number` | `undefined` | `> 0` | Per-task timeout in milliseconds. Each **retry attempt** receives its own full timeout window. If a task does not settle in time, it is rejected with `Error: Task[N] timed out after Xms`. |
| `retries` | `number` | `0` | `>= 0` | How many additional attempts to make if a task fails. A task is only considered permanently failed after all retries are exhausted. |
| `retryDelay` | `number` | `0` | `>= 0` | Milliseconds to wait between retry attempts. |
| `signal` | `AbortSignal` | `undefined` | — | An `AbortSignal` that can cancel the entire pool run. See [Abort and cancellation](#abort-and-cancellation). |

**Throws** `RangeError` if `limit < 1`, `retries < 0`, or `retryDelay < 0`.

---

### `pool.run`

```ts
pool.run<T>(tasks: Array<() => T | Promise<T>>): Promise<T[]>
```

Executes an array of task functions under the pool's concurrency limit.

- Tasks are dispatched in **FIFO order**.
- Both synchronous and asynchronous task functions are accepted; synchronous throws are safely caught and converted to rejections.
- Returns a `Promise<T[]>` that resolves with results in the **same order as the input array**.
- Rejects with the **first error** that is not resolved by retries.

```ts
const results = await pool.run([
  () => fetchUser(1),
  () => fetchUser(2),
  () => fetchUser(3),
]);
// results[0] = user 1, results[1] = user 2, results[2] = user 3
```

---

### `createDedup`

```ts
import { createDedup } from 'dedupflow';

const dedupedFn = createDedup(fn, options?: DedupOptions): DedupFunction;
```

Wraps any async (or sync) function with in-flight deduplication and optional TTL caching.

```ts
interface DedupOptions<TArgs> {
  ttl?:     number;                     // default: undefined (no expiry)
  cache?:   boolean;                    // default: true
  maxSize?: number;                     // default: undefined (unbounded)
  key?:     (...args: TArgs) => string; // default: JSON.stringify(args)
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `ttl` | `number` | `undefined` | Time-to-live in milliseconds. Omit to keep entries until `clearCache()` is called. |
| `cache` | `boolean` | `true` | Whether to cache successful results. Set to `false` to keep in-flight deduplication but skip caching. |
| `maxSize` | `number` | `undefined` | Maximum number of entries. When the limit is reached, the oldest entry is evicted (FIFO) before a new one is stored. |
| `key` | `(...args) => string` | `JSON.stringify(args)` | Derives the cache key from call arguments. Provide a custom function for complex, circular, or non-serialisable arguments. |

---

### Dedup methods

The wrapped function exposes three additional methods:

```ts
// Normal call — applies deduplication and cache
dedupedFn(...args);

// Bypass dedup and cache entirely — always calls the original function
dedupedFn.raw(...args);

// Evict the existing in-flight or cached entry for these args, then execute fresh
dedupedFn.force(...args);

// Remove all cached entries immediately (does not affect in-flight requests)
dedupedFn.clearCache();
```

---

## Behaviour In Depth

### Concurrency and fail-fast

`pool.run` is **fail-fast**: as soon as one task fails (after exhausting all retries), the pool stops scheduling new work.

- Tasks that are **already running** are **not cancelled** — they run to completion.
- Results from tasks that complete after the pool has already failed are **silently discarded**.
- The pool rejects with the **first error** encountered; all subsequent errors are ignored.
- The pool resolves only when **every** task has completed successfully.

```ts
const pool = createPool({ limit: 2 });

try {
  await pool.run([
    () => doWork(1),                         // started — result kept if it finishes before failure
    () => Promise.reject(new Error('boom')), // fails immediately
    () => doWork(3),                         // queued — NOT started after failure
  ]);
} catch (err) {
  console.error(err.message); // "boom"
}
```

---

### Timeout

```ts
const pool = createPool({ limit: 2, timeout: 3_000 });
```

- If a task does not settle within `timeout` ms it is rejected with:
  `Error: Task[N] timed out after 3000ms`
- A timed-out task follows the same fail-fast rules as any other failed task.
- If `retries` is configured, each retry attempt receives its own **independent** full timeout window (see [Timeout and retry interaction](#timeout-and-retry-interaction)).
- Timeout is optional. Without it, tasks may run indefinitely.

---

### Retries

```ts
const pool = createPool({ limit: 3, retries: 3, retryDelay: 200 });
```

- `retries` is the number of **additional** attempts after the initial execution. `retries: 2` means up to **3 total attempts**.
- Each retry is a **fresh execution** of the task function.
- `retryDelay` is the wait between the end of a failed attempt and the start of the next.
- A task is only considered permanently failed once **all retries are exhausted**.
- If the pool is aborted or fails due to another task while a retry delay is in progress, the retry loop exits immediately — no further attempts are made.

```ts
let attempts = 0;
const pool = createPool({ limit: 1, retries: 2, retryDelay: 100 });

await pool.run([
  () => {
    attempts++;
    if (attempts < 3) throw new Error('not yet');
    return 'success';
  },
]);
// attempts === 3 — task succeeded on the 3rd try
```

---

### Abort and cancellation

```ts
const controller = new AbortController();
const pool = createPool({ limit: 3, signal: controller.signal });

// Cancel from anywhere
controller.abort();
```

**Before `run()` is called:**

If `signal.aborted` is already `true` when `pool.run()` is invoked, the call rejects immediately:

```ts
new Error('Pool execution aborted')
```

No tasks are started.

**During execution:**

When `abort()` is called while tasks are running:

- The pool stops scheduling any new or queued tasks immediately.
- Tasks that are **already running** are allowed to finish (they cannot be cancelled).
- Their results are silently discarded.
- The outer `Promise` rejects immediately with `new Error('Pool execution aborted')`.

**Memory safety:**

The abort event listener is always removed once the pool settles (resolve or reject), preventing memory leaks.

```ts
const controller = new AbortController();
const pool = createPool({ limit: 5, signal: controller.signal });

const promise = pool.run(heavyTasks);

setTimeout(() => controller.abort(), 500); // cancel after 500 ms

try {
  await promise;
} catch (err) {
  console.error(err.message); // "Pool execution aborted"
}
```

---

### Timeout and retry interaction

Each retry attempt receives a **full, independent timeout window**.

```
timeout: 2_000ms   retries: 2
                                    
Attempt 1: [ task running ... ] timeout: 2000ms
           fails at 2000ms
                                    
Delay: retryDelay ms
                                    
Attempt 2: [ task running ... ] timeout: 2000ms  <-- fresh timer
           fails at 2000ms
                                    
Delay: retryDelay ms
                                    
Attempt 3: [ task running ... ] timeout: 2000ms  <-- fresh timer
           succeeds or gives up
```

Worst-case total time for one task = `(timeout + retryDelay) * (retries + 1)`.

---

### In-flight deduplication

```ts
const dedupedFetch = createDedup(fetchUser);

// These three calls are made concurrently with the same key
const [a, b, c] = await Promise.all([
  dedupedFetch(42),
  dedupedFetch(42), // same in-flight promise — fetchUser called once
  dedupedFetch(42), // same in-flight promise — fetchUser called once
]);
// a === b === c
```

- While a call is in flight, any additional call with the same key receives the **same promise**.
- The underlying function is only called **once per key** per in-flight window.
- If the call fails, the in-flight entry is removed and the next call retries the function.
- **Failures are never deduplicated** — a failed call does not short-circuit subsequent attempts.

---

### TTL cache

```ts
const dedupedFetch = createDedup(fetchUser, { ttl: 5_000 });
```

| Scenario | Behaviour |
|---|---|
| Within TTL | Cached value returned immediately; function not called |
| TTL expired | Entry evicted; function called fresh |
| No TTL set | Entry lives until `clearCache()` is called |
| `cache: false` | No caching; in-flight dedup still applies for concurrent calls |
| `maxSize` reached | Oldest entry evicted (FIFO) before new entry is stored |

**Background cleanup:**  
When `ttl` is configured, a background interval evicts stale entries automatically. The interval fires every `ttl / 2` ms, clamped between 500 ms and 60 s. The timer is `unref()`'d so it never prevents the Node.js process from exiting.

**Failure policy:**  
Failed executions are **never cached**. The in-flight entry is removed so the next call retries the function fresh.

---

### Cache key generation

By default, call arguments are serialised with `JSON.stringify(args)`.

```ts
dedupedFetch(1, 'admin') // key: '[1,"admin"]'
```

**`JSON.stringify` is not safe for:**

- Circular object references
- Non-serialisable values: `undefined`, `Function`, `Symbol`, `BigInt`
- Very large or deeply nested objects (performance impact)

In any of these cases, provide a `key` function:

```ts
const search = createDedup(searchFn, {
  key: (query, page) => `${query}:${page}`,
});

const userOp = createDedup(updateUser, {
  key: (user) => `user:${user.id}`,
});
```

If `JSON.stringify` throws (e.g. on a circular reference), dedupflow raises:

```
TypeError: dedupflow: Failed to serialize arguments to a cache key.
Provide a custom `key` function via the options parameter.
```

---

## Examples

### Concurrency pool — basic

```ts
import { createPool } from 'dedupflow';

const pool = createPool({ limit: 2 });

const tasks = Array.from({ length: 10 }, (_, i) => () =>
  fetch(`/api/item/${i}`).then(r => r.json())
);

const results = await pool.run(tasks);
```

### Concurrency pool — with retries and timeout

```ts
const pool = createPool({ limit: 3, timeout: 5_000, retries: 2, retryDelay: 500 });

// Each task gets up to 3 attempts (initial + 2 retries),
// each attempt has a 5 s timeout.
const results = await pool.run([
  () => fetchFromUnstableApi(1),
  () => fetchFromUnstableApi(2),
]);
```

### Concurrency pool — with AbortController

```ts
const controller = new AbortController();

const pool = createPool({ limit: 5, signal: controller.signal });

// Cancel all pending work after 2 seconds
setTimeout(() => controller.abort(), 2_000);

try {
  await pool.run(longRunningTasks);
} catch (err) {
  // err.message === "Pool execution aborted"
}
```

### Deduplication — in-flight only (no caching)

```ts
import { createDedup } from 'dedupflow';

const deduped = createDedup(expensiveOp, { cache: false });

// Two concurrent calls with the same argument — one execution
const [a, b] = await Promise.all([deduped('x'), deduped('x')]);
```

### Deduplication — with TTL cache

```ts
const cachedFetch = createDedup(fetchUser, { ttl: 30_000 });

// First call executes fetchUser
const user1 = await cachedFetch(42);

// Within 30 s — returns cached result immediately
const user2 = await cachedFetch(42);
```

### Deduplication — bounded cache

```ts
const cachedFetch = createDedup(fetchUser, {
  ttl: 60_000,
  maxSize: 500, // evict oldest entries when cache exceeds 500 items
});
```

### Deduplication — custom cache key

```ts
const cachedSearch = createDedup(searchFn, {
  ttl: 10_000,
  key: (query, page) => `${query}:${page}`,
});
```

### Force a fresh execution

```ts
// Bypasses in-flight dedup and evicts any cached entry for this key
await cachedFetch.force(42);
```

### Bypass all dedup and cache logic

```ts
// Always calls the original function directly
await cachedFetch.raw(42);
```

### Error propagation

```ts
const pool = createPool({ limit: 3 });

try {
  await pool.run([
    () => Promise.resolve('ok'),
    () => Promise.reject(new Error('something failed')),
    () => Promise.resolve('also ok'),
  ]);
} catch (err) {
  console.error(err.message); // "something failed"
}
```

### Synchronous task functions

```ts
const pool = createPool({ limit: 2 });

const results = await pool.run([
  () => 1 + 1,       // synchronous — safely wrapped
  () => fetchData(), // asynchronous
]);
```

### Combining pool + dedup

```ts
const pool = createPool({ limit: 4, retries: 1 });
const fetchUser = createDedup(getUserFromDB, { ttl: 10_000 });

// Executes at most 4 requests at once, deduplicates repeated IDs,
// and retries transient failures once.
const users = await pool.run(
  userIds.map(id => () => fetchUser(id))
);
```

---

## Edge Cases

| Situation | Behaviour |
|---|---|
| Empty task array passed to `pool.run` | Resolves immediately with `[]` |
| `limit < 1` | Throws `RangeError: Pool limit must be at least 1` |
| `retries < 0` | Throws `RangeError: Pool retries must be at least 0` |
| `retryDelay < 0` | Throws `RangeError: Pool retryDelay must be at least 0` |
| Synchronous task function | Wrapped in `Promise.resolve().then()` — throws are caught and treated as rejections |
| `signal` already aborted before `run()` | Rejects immediately with `Error: Pool execution aborted` without starting any tasks |
| Pool fails while a retry delay is in progress | Retry loop exits immediately; no further attempts are made |
| Circular argument with default key | Throws `TypeError` with guidance to use a custom `key` function |
| `maxSize: 0` or `maxSize: 1` | Works correctly — oldest entry is evicted before each insert |

---

## Limitations

The following are **intentional design constraints**, not bugs:

- **In-memory only** — no persistence across process restarts or crashes.
- **Single-process only** — cache and dedup state is not shared between Node.js worker threads, cluster workers, or separate processes. Do not use as a distributed cache or job queue.
- **No priority scheduling** — tasks execute in FIFO order only.
- **No dynamic concurrency** — `limit` is fixed at pool creation time and cannot be changed at runtime.
- **No result aggregation for partial success** — the pool is all-or-nothing: it either resolves with all results or rejects on the first failure.
- **Running tasks cannot be cancelled** — `AbortSignal` prevents new tasks from starting and discards results of running tasks, but it cannot interrupt a task mid-execution. Cancellation of the underlying work (e.g. an HTTP request) must be implemented inside the task itself.
- **No cross-instance deduplication** — each `createDedup` call creates an independent in-flight map and cache. Two separate instances wrapping the same function do not share state.

---

## What Is Not Included (By Design)

The following features are **out of scope** and will not be added:

| Feature | Why excluded |
|---|---|
| Persistent job queue | Would require an external dependency or storage layer |
| Distributed locking | Out of scope for an in-memory library |
| Priority queue | Adds scheduling complexity; use a dedicated library |
| Event emitters / observability hooks | Increases API surface; compose with your own wrappers |
| Execution modes (race, all-settled, etc.) | Use `Promise.race` / `Promise.allSettled` directly |
| Dynamic concurrency adjustment | Complicates internal scheduling; keep limit static |

---

## Design Principles

- **Zero external dependencies** — pure TypeScript; runs on any Node.js ≥ 14 environment without extra packages.
- **In-memory only** — no I/O, no persistence, no side effects outside the process.
- **Fail-safe** — errors propagate correctly and never corrupt internal state.
- **No memory leaks** — background cleanup intervals are `unref()`'d; in-flight maps and abort listeners are always cleaned up on settle.
- **Composable** — `createPool` and `createDedup` are independent building blocks that can be combined freely.
- **Predictable** — behaviour is deterministic and fully synchronous where possible; no hidden retries, background queues, or global state.

---

## Project Structure

```
src/
  index.ts        Public API re-exports
  pool.ts         Concurrency pool (createPool)
  dedup.ts        Deduplication engine + TTL cache (createDedup)
tests/
  pool.test.ts
  dedup.test.ts
```

---

## License

[MIT](./LICENSE)
