/**
 * pool.ts — Concurrency Pool
 *
 * Controls how many async tasks run simultaneously.
 * Excess tasks are queued and started automatically as running tasks finish.
 */

export interface PoolOptions {
  /** Maximum number of tasks that may run concurrently. Defaults to 5. */
  limit?: number;
}

export interface Pool {
  /**
   * Run an array of task functions with concurrency capped at the pool limit.
   * Resolves with an array of results in the same order as the input tasks.
   * Rejects with the first error encountered (other in-flight tasks still finish).
   */
  run<T>(tasks: Array<() => Promise<T>>): Promise<T[]>;
}

/**
 * Creates a reusable concurrency pool.
 *
 * @param options.limit  Max concurrent tasks (default 5).
 */
export function createPool(options?: PoolOptions): Pool {
  const limit = options?.limit ?? 5;

  if (limit < 1) {
    throw new RangeError("Pool limit must be at least 1");
  }

  return {
    run<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
      return new Promise<T[]>((resolve, reject) => {
        // Pre-allocate result slots so we can fill them in order regardless of
        // which task finishes first.
        const results: T[] = new Array(tasks.length);

        // Index of the next task that has not yet been dispatched.
        let nextIndex = 0;

        // Number of tasks that have fully completed (resolved or rejected).
        let completedCount = 0;

        // Once any task rejects, we stop launching new tasks and reject the
        // overall promise.  We keep this flag so we reject only once.
        let failed = false;

        // Edge-case: empty task list resolves immediately.
        if (tasks.length === 0) {
          resolve(results);
          return;
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

          // Execute the task and capture its result slot.
          task()
            .then((result) => {
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
              // Mark as failed so pending dispatches are skipped.
              failed = true;
              reject(err);
            });
        }

        // Seed the pool: kick off up to `limit` tasks at once.
        const initialCount = Math.min(limit, tasks.length);
        for (let i = 0; i < initialCount; i++) {
          startNext();
        }
      });
    },
  };
}
