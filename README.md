# dedupflow

A lightweight, production-ready npm library for Node.js that provides async execution control with **no external dependencies**.

## Features

| Feature | Description |
|---|---|
| **Concurrency Pool** | Limit how many async tasks run at the same time |
| **In-flight Deduplication** | Prevent duplicate concurrent executions for the same input |
| **TTL Cache** | Cache results in memory with automatic expiry and optional size cap |

---

## Installation

```bash
npm install dedupflow
```

---

## Quick Start

```ts
import { createPool, createDedup } from 'dedupflow';

const pool = createPool({ limit: 3 });

const fetchUser = async (id: number) => {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
};

// Wrap fetchUser with deduplication + 5-second TTL cache
const cachedFetch = createDedup(fetchUser, { ttl: 5000 });

const results = await pool.run([
  () => cachedFetch(1),
  () => cachedFetch(1), // deduped — shares the same in-flight request
  () => cachedFetch(2),
]);
// fetchUser is called exactly twice (once per unique id)
```

---

## API

### `createPool(options?)`

Creates a concurrency-limited task runner.

```ts
const pool = createPool({ limit: 3, timeout: 5000 });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `5` | Maximum number of tasks that may run concurrently. Must be ≥ 1. |
| `timeout` | `number` | `undefined` | Per-task timeout in milliseconds. If a task exceeds this duration it is rejected. Optional — no timeout by default. |

#### `pool.run(tasks)`

Runs an array of task functions with the configured concurrency limit.

- Tasks execute in **FIFO order**.
- Both sync and async task functions are supported.
- Returns a `Promise<T[]>` that resolves with results in **input order**.
- Rejects with the first error encountered (see [Concurrency Behaviour](#concurrency-behaviour)).

```ts
const results = await pool.run([
  () => fetchUser(1),
  () => fetchUser(2),
  () => fetchUser(3),
]);
```

---

### `createDedup(fn, options?)`

Wraps an async function with in-flight deduplication and optional TTL caching.

```ts
const cachedFetch = createDedup(fetchUser, {
  ttl: 5000,      // cache results for 5 seconds
  cache: true,    // enable caching (default)
  maxSize: 500,   // evict oldest entries when cache exceeds 500 items
  key: (id) => String(id), // custom cache key (default: JSON.stringify(args))
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `ttl` | `number` | `undefined` | Time-to-live for cached results in milliseconds. Omit to cache indefinitely. |
| `cache` | `boolean` | `true` | Whether to cache successful results |
| `maxSize` | `number` | `undefined` | Maximum number of cache entries. Oldest entries are evicted first (FIFO) when the limit is reached. |
| `key` | `(...args) => string` | `JSON.stringify(args)` | Derives the cache key from arguments. Provide a custom function for complex or circular objects. |

#### Deduplication behaviour

If the same function is already running with the same key, additional calls **return the same in-flight promise** — the underlying function is not called again.

#### Cache behaviour

After a successful call, the result is stored. Subsequent calls with the same key return the cached value immediately until it expires.

Expired entries are evicted automatically by a background interval (runs every `ttl / 2` ms, clamped between 500 ms and 60 s).

#### Failure handling

Failed executions are **never** cached. The in-flight entry is removed so the next call retries the function.

#### Additional methods

```ts
// Call the original function directly — bypasses all dedup and cache
cachedFetch.raw(id);

// Force a fresh execution, evicting any existing in-flight or cached entry
cachedFetch.force(id);

// Clear all cached results immediately
cachedFetch.clearCache();
```

---

## Concurrency Behaviour

`pool.run` executes tasks in **FIFO order** up to the configured `limit`.

**On error:**
- No new tasks are scheduled after the first failure.
- Tasks that are **already running** are **not cancelled** — they continue to completion.
- Results from tasks that complete after a failure are discarded.
- The pool rejects with the **first error** encountered.
- Subsequent errors from still-running tasks are silently ignored (the Promise is already settled).

```ts
const pool = createPool({ limit: 3 });

try {
  await pool.run([
    () => doWork(1),  // running — result kept if it finishes before failure
    () => Promise.reject(new Error('boom')), // fails
    () => doWork(3),  // queued — NOT started after failure
  ]);
} catch (err) {
  console.error(err.message); // "boom"
}
```

---

## Timeout Behaviour

Set a per-task timeout via `createPool({ timeout: ms })`.

- If a task does not settle within the given time it is rejected with:
  `Error: Task[N] timed out after 3000ms` (where N is the task's index in the array)
- The timeout **does not stop the pool** — other tasks continue normally.
- A timed-out task counts as a failed task (same error propagation rules apply).
- Timeout is optional. Without it, tasks may run indefinitely.

```ts
const pool = createPool({ limit: 2, timeout: 3000 });

await pool.run([
  () => fastOperation(),   // completes in time
  () => slowOperation(),   // exceeds 3 s → rejected with timeout error
]);
```

---

## Cache Behaviour

| Scenario | Behaviour |
|---|---|
| Within TTL | Cached value returned immediately, function not called |
| TTL expired | Entry evicted, function called fresh |
| No TTL set | Entry lives indefinitely (until `clearCache()` or GC) |
| `cache: false` | No caching; in-flight dedup still applies for concurrent calls |
| `maxSize` reached | Oldest entry evicted (FIFO) before new entry is stored |

**Eviction strategy:** FIFO — the entry that was inserted first is removed first when `maxSize` is exceeded. TTL expiry runs independently on a background interval and removes stale entries regardless of `maxSize`.

---

## Key Generation

By default, arguments are serialised with `JSON.stringify(args)` to produce a cache key.

> **Warning:** `JSON.stringify` is not safe for:
> - Circular object references
> - Non-serialisable values (`undefined`, `Function`, `Symbol`, `BigInt`)
> - Large or deeply nested objects (performance)
>
> For these cases, **always provide a custom `key` function**:

```ts
const deduped = createDedup(fn, {
  key: (user) => `user:${user.id}`,
});
```

If `JSON.stringify` throws (e.g. circular reference), dedupflow raises a `TypeError` with a descriptive message pointing to the `key` option.

---

## Examples

### Limit concurrency to 2

```ts
import { createPool } from 'dedupflow';

const pool = createPool({ limit: 2 });

const tasks = Array.from({ length: 10 }, (_, i) => () =>
  fetch(`/api/item/${i}`).then(r => r.json())
);

const results = await pool.run(tasks);
```

### Deduplicate without caching

```ts
import { createDedup } from 'dedupflow';

const deduped = createDedup(expensiveOp, { cache: false });

// Two concurrent calls → one execution
const [a, b] = await Promise.all([deduped('x'), deduped('x')]);
```

### Custom cache key

```ts
const cachedSearch = createDedup(searchFn, {
  ttl: 10_000,
  key: (query, page) => `${query}:${page}`,
});
```

### Bounded cache (evict oldest when full)

```ts
const cachedFetch = createDedup(fetchUser, {
  ttl: 60_000,
  maxSize: 200, // keep at most 200 users in cache
});
```

### Per-task timeout

```ts
const pool = createPool({ limit: 4, timeout: 2000 });

await pool.run(tasks); // any task running > 2 s is rejected
```

### Sync task functions

```ts
// Pool accepts both sync and async functions
const pool = createPool({ limit: 2 });
const results = await pool.run([
  () => 1 + 1,          // sync
  () => fetchData(),     // async
]);
```

### Error propagation

```ts
const pool = createPool({ limit: 3 });

try {
  await pool.run([
    () => Promise.resolve('ok'),
    () => Promise.reject(new Error('something failed')),
  ]);
} catch (err) {
  console.error(err.message); // "something failed"
}
```

---

## Edge Cases

| Situation | Behaviour |
|---|---|
| Empty task array | Resolves immediately with `[]` |
| `limit <= 0` | Throws `RangeError: Pool limit must be at least 1` |
| Sync task function | Safely wrapped in `Promise.resolve().then()` |
| Circular argument in default key | Throws `TypeError` with guidance to use custom `key` |

---

## Limitations

- **In-memory only** — no persistence across process restarts.
- **Single instance** — cache and deduplication state is not shared across multiple Node.js processes or machines. Not suitable for distributed/multi-instance systems.
- **No cache warming** — cache is empty on startup; the first call for any key always executes the function.
- **FIFO pool only** — no priority scheduling.

---

## Project Structure

```
src/
  pool.ts    # Concurrency pool implementation
  dedup.ts   # Deduplication engine + TTL cache
  index.ts   # Public API re-exports
tests/
  pool.test.ts
  dedup.test.ts
```

---

## Design Principles

- **No external dependencies** — pure Node.js / TypeScript
- **In-memory only** — no persistence layer
- **Fail-safe** — errors propagate correctly, never corrupt internal state
- **No memory leaks** — cleanup intervals are unref'd; in-flight maps are always cleaned up

---

## License

MIT
