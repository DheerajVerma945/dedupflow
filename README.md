# dedupflow

A lightweight, production-ready npm library for Node.js that provides async execution control with **no external dependencies**.

## Features

| Feature | Description |
|---|---|
| **Concurrency Pool** | Limit how many async tasks run at the same time |
| **In-flight Deduplication** | Prevent duplicate concurrent executions for the same input |
| **TTL Cache** | Cache results in memory with automatic expiry |

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
const pool = createPool({ limit: 3 });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `5` | Maximum number of tasks that may run concurrently |

#### `pool.run(tasks)`

Runs an array of async task functions with the configured concurrency limit.

- Tasks execute in **FIFO order**.
- Returns a `Promise<T[]>` that resolves with results in **input order**.
- Rejects with the first error encountered.

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
  ttl: 5000,   // cache results for 5 seconds
  cache: true, // enable caching (default)
  key: (id) => String(id), // custom cache key (default: JSON.stringify(args))
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `ttl` | `number` | `undefined` | Time-to-live for cached results in milliseconds. Omit to cache indefinitely. |
| `cache` | `boolean` | `true` | Whether to cache successful results |
| `key` | `(...args) => string` | `JSON.stringify(args)` | Derives the cache key from arguments |

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
cachedFetch.forceCall(id);

// Clear all cached results immediately
cachedFetch.clearCache();
```

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
