/**
 * index.ts — Public API
 *
 * Re-exports the two primary building blocks of the dedupflow library:
 *  - createPool  – concurrency-limited task runner
 *  - createDedup – in-flight deduplication + TTL cache wrapper
 */

export { createPool } from "./pool";
export type { Pool, PoolOptions } from "./pool";

export { createDedup } from "./dedup";
export type { DedupOptions, DedupFunction, CallOptions } from "./dedup";
