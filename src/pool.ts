/**
 * pool.ts — Concurrency Pool
 *
 * Controls how many async tasks run simultaneously.
 * Excess tasks are queued in FIFO order and started automatically as running
 * tasks finish.
 *
 * Error behaviour:
 *  - If any task fails, no NEW tasks are started.
 *  - Already-running tasks continue to completion (their results are discarded).
 *  - The pool rejects with the FIRST error encountered; subsequent errors are
 *    silently ignored (the outer Promise is already settled).
 */

export interface PoolOptions {
  /** Maximum number of tasks that may run concurrently. Defaults to 5. */
  limit?: number;

  /**
   * Per-task timeout in milliseconds.
   * If a task does not settle within this time it is rejected with a
   * `TaskTimeoutError`.  Other tasks are not affected and the pool continues
   * running until all slots are empty.  Optional — no timeout by default.
   */
  timeout?: number;
}

export interface Pool {
  /**
   * Run an array of task functions with concurrency capped at the pool limit.
   * Tasks execute in FIFO order.
   * Resolves with an array of results in the same order as the input tasks.
   * Rejects with the first error encountered; already-running tasks finish.
   */
  run<T>(tasks: Array<() => T | Promise<T>>): Promise<T[]>;
}

/**
 * Creates a reusable concurrency pool.
 *
 * @param options.limit    Max concurrent tasks (default 5, must be ≥ 1).
 * @param options.timeout  Per-task timeout in ms (optional).
 */
export function createPool(options?: PoolOptions): Pool {
  const limit = options?.limit ?? 5;
  const timeout = options?.timeout;

  if (limit < 1) {
    throw new RangeError("Pool limit must be at least 1");
  }

  return {
    run<T>(tasks: Array<() => T | Promise<T>>): Promise<T[]> {
      // Edge-case: empty task list resolves immediately.
      if (tasks.length === 0) {
        return Promise.resolve([]);
      }

      return new Promise<T[]>((resolve, reject) => {
        // Pre-allocate result slots so we can fill them in order regardless of
        // which task finishes first.
        const results: T[] = new Array(tasks.length);

        // Index of the next task that has not yet been dispatched.
        let nextIndex = 0;

        // Number of tasks that have successfully completed.
        let completedCount = 0;

        // Once any task rejects, we stop launching new tasks and reject the
        // overall promise.  We keep this flag so we reject only once.
        let failed = false;

        /**
         * Wraps a single task invocation with an optional timeout.
         * Uses `Promise.resolve().then()` so that synchronous tasks and
         * synchronous throws are handled safely as Promise rejections.
         */
        function runTask(task: () => T | Promise<T>, index: number): Promise<T> {
          // Run inside a microtask so synchronous throws become rejections.
          const taskPromise = Promise.resolve().then(() => task()) as Promise<T>;

          if (timeout == null) {
            return taskPromise;
          }

          // Race the task promise against a timeout deadline.
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

        /**
         * Attempts to start the next queued task if the concurrency limit
         * allows it.  Called once at startup for each "slot" and then again
         * every time a running task completes.
         */
        function startNext(): void {
          // Do not start new work after a failure.
          if (failed) return;

          // All tasks have been dispatched — nothing to start.
          if (nextIndex >= tasks.length) return;

          const taskIndex = nextIndex++;
          const task = tasks[taskIndex];

          // Execute the task (with optional timeout) and store the result.
          runTask(task, taskIndex)
            .then((result) => {
              // Discard result if pool has already failed.
              if (failed) return;

              results[taskIndex] = result;
              completedCount++;

              if (completedCount === tasks.length) {
                // Every task has finished successfully.
                resolve(results);
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
              reject(err);
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
