/**
 * pool.ts — Concurrency Pool
 *
 * Controls how many async tasks run simultaneously.
 * Excess tasks are queued in FIFO order and started automatically as running
 * tasks finish.
 *
 * Error behaviour:
 *  - If any task fails (after all retries are exhausted), no NEW tasks are started.
 *  - Already-running tasks continue to completion (their results are discarded).
 *  - The pool rejects with the FIRST error encountered; subsequent errors are
 *    silently ignored (the outer Promise is already settled).
 *
 * Phase 3 additions:
 *  - retries / retryDelay: per-task retry with independent timeout per attempt.
 *  - signal: AbortSignal support for graceful cancellation.
 */

export interface PoolOptions {
  /** Maximum number of tasks that may run concurrently. Defaults to 5. */
  limit?: number;

  /**
   * Per-task timeout in milliseconds.
   * Each retry attempt gets its own full timeout window.
   * Optional — no timeout by default.
   */
  timeout?: number;

  /**
   * Number of times to retry a failing task before treating it as a failure.
   * Defaults to 0 (no retries).  Must be ≥ 0.
   */
  retries?: number;

  /**
   * Milliseconds to wait between retry attempts.
   * Defaults to 0 (immediate retry).  Must be ≥ 0.
   */
  retryDelay?: number;

  /**
   * An AbortSignal that can cancel the entire pool run.
   * - If already aborted when run() is called → immediate rejection.
   * - If aborted during execution → stop scheduling; reject immediately.
   *   Running tasks are allowed to finish but their results are ignored.
   */
  signal?: AbortSignal;
}

export interface Pool {
  /**
   * Run an array of task functions with concurrency capped at the pool limit.
   * Tasks execute in FIFO order.
   * Resolves with an array of results in the same order as the input tasks.
   * Rejects with the first error encountered (after retries); already-running
   * tasks finish silently.
   */
  run<T>(tasks: Array<() => T | Promise<T>>): Promise<T[]>;
}

/**
 * Creates a reusable concurrency pool.
 *
 * @param options.limit       Max concurrent tasks (default 5, must be ≥ 1).
 * @param options.timeout     Per-task timeout in ms, per retry attempt (optional).
 * @param options.retries     Per-task retry count (default 0).
 * @param options.retryDelay  Delay between retries in ms (default 0).
 * @param options.signal      AbortSignal for cancellation (optional).
 */
export function createPool(options?: PoolOptions): Pool {
  const limit = options?.limit ?? 5;
  const timeout = options?.timeout;
  const retries = options?.retries ?? 0;
  const retryDelay = options?.retryDelay ?? 0;
  const signal = options?.signal;

  if (limit < 1) {
    throw new RangeError("Pool limit must be at least 1");
  }
  if (retries < 0) {
    throw new RangeError("Pool retries must be at least 0");
  }
  if (retryDelay < 0) {
    throw new RangeError("Pool retryDelay must be at least 0");
  }

  return {
    run<T>(tasks: Array<() => T | Promise<T>>): Promise<T[]> {
      // Edge-case: empty task list resolves immediately.
      if (tasks.length === 0) {
        return Promise.resolve([]);
      }

      // If the signal is already aborted before we even start, reject now.
      if (signal?.aborted) {
        return Promise.reject(new Error("Pool execution aborted"));
      }

      return new Promise<T[]>((resolve, reject) => {
        // Pre-allocate result slots so we can fill them in order regardless of
        // which task finishes first.
        const results: T[] = new Array(tasks.length);

        // Index of the next task that has not yet been dispatched.
        let nextIndex = 0;

        // Number of tasks that have successfully completed.
        let completedCount = 0;

        // Once any task rejects (after retries) or abort fires, we stop
        // launching new tasks and reject the overall promise.  We keep this
        // flag so we settle only once.
        let failed = false;

        // ── Abort support ────────────────────────────────────────────────────

        // Called when the AbortSignal fires.  Marks the pool as failed and
        // rejects the outer promise; any currently-running tasks are allowed
        // to finish but their results will be discarded.
        const onAbort = (): void => {
          if (failed) return; // already settled — nothing to do
          failed = true;
          reject(new Error("Pool execution aborted"));
        };

        signal?.addEventListener("abort", onAbort);

        // Convenience wrapper: settle the outer promise exactly once and
        // always clean up the abort listener to avoid memory leaks.
        function settle(fn: () => void): void {
          signal?.removeEventListener("abort", onAbort);
          fn();
        }

        // ── Per-attempt execution ─────────────────────────────────────────────

        /**
         * Wraps a single task invocation with an optional timeout.
         * Uses `Promise.resolve().then()` so synchronous throws are safely
         * converted to rejections.
         *
         * Each call to runOnce gets its own independent timeout timer so that
         * every retry attempt has the full timeout budget.
         */
        function runOnce(task: () => T | Promise<T>, index: number): Promise<T> {
          // Ensure synchronous throws become Promise rejections.
          const taskPromise = Promise.resolve().then(() => task()) as Promise<T>;

          if (timeout == null) {
            return taskPromise;
          }

          // Race the task promise against a per-attempt timeout deadline.
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`Task[${index}] timed out after ${timeout}ms`));
            }, timeout);

            taskPromise.then(
              (result) => { clearTimeout(timer); res(result); },
              (err: unknown) => { clearTimeout(timer); rej(err); }
            );
          });
        }

        // ── Retry wrapper ─────────────────────────────────────────────────────

        /**
         * Executes a task with retry logic.
         *
         * Responsibilities:
         *  - Invoke runOnce (which applies per-attempt timeout).
         *  - On failure, wait `retryDelay` ms then try again — up to `retries`
         *    additional times.
         *  - Before each retry, check `failed`; if the pool has already been
         *    aborted or failed by another task, bail out immediately so we do
         *    not waste work.
         *  - A task is only considered "failed" once ALL retry attempts are
         *    exhausted.
         */
        async function executeWithRetry(
          task: () => T | Promise<T>,
          index: number
        ): Promise<T> {
          let retriesRemaining = retries; // number of retries remaining after 1st try

          while (true) {
            try {
              // Each attempt gets a fresh, independent timeout timer via runOnce.
              return await runOnce(task, index);
            } catch (err: unknown) {
              // If the pool has already failed (abort or another task failure),
              // stop retrying immediately — there is no point continuing.
              if (failed) throw err;

              // No retries left — propagate the error as a real failure.
              if (retriesRemaining <= 0) throw err;

              retriesRemaining--;

              // Wait between retries if a delay is configured.
              if (retryDelay > 0) {
                await new Promise<void>((res) => setTimeout(res, retryDelay));
              }

              // After the delay, re-check the failed flag; the pool may have
              // been aborted or killed by another task while we were waiting.
              if (failed) throw err;
            }
          }
        }

        // ── Scheduler ─────────────────────────────────────────────────────────

        /**
         * Attempts to start the next queued task if the concurrency limit
         * allows it.  Called once at startup for each "slot" and then again
         * every time a running task completes.
         */
        function startNext(): void {
          // Do not start new work after a failure or abort.
          if (failed) return;

          // All tasks have been dispatched — nothing to start.
          if (nextIndex >= tasks.length) return;

          const taskIndex = nextIndex++;
          const task = tasks[taskIndex];

          // Execute the task (with retry + timeout) and store the result.
          executeWithRetry(task, taskIndex)
            .then((result) => {
              // Discard result if pool has already failed or been aborted.
              if (failed) return;

              results[taskIndex] = result;
              completedCount++;

              if (completedCount === tasks.length) {
                // Every task has finished successfully.
                settle(() => resolve(results));
              } else {
                // Free up one concurrency slot and pull the next task off the
                // queue.
                startNext();
              }
            })
            .catch((err: unknown) => {
              // Guard against multiple rejections from simultaneous failures.
              if (failed) return;
              // Mark as failed so no new tasks are dispatched.
              failed = true;
              settle(() => reject(err));
            });
        }

        // Seed the pool: kick off up to `limit` tasks simultaneously (FIFO).
        const initialCount = Math.min(limit, tasks.length);
        for (let i = 0; i < initialCount; i++) {
          startNext();
        }
      });
    },
  };
}
