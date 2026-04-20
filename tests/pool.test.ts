import { createPool } from "../src/pool";

describe("createPool", () => {
  test("resolves with results in input order", async () => {
    const pool = createPool({ limit: 2 });
    const results = await pool.run([
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  test("empty task list resolves to empty array", async () => {
    const pool = createPool({ limit: 3 });
    const results = await pool.run([]);
    expect(results).toEqual([]);
  });

  test("default limit is 5", async () => {
    const pool = createPool();
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      new Promise<void>((resolve) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        setImmediate(() => {
          concurrent--;
          resolve();
        });
      });

    await pool.run(Array.from({ length: 10 }, () => task));
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  test("respects concurrency limit", async () => {
    const pool = createPool({ limit: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      new Promise<void>((resolve) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        setImmediate(() => {
          concurrent--;
          resolve();
        });
      });

    await pool.run(Array.from({ length: 8 }, () => task));
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("propagates errors", async () => {
    const pool = createPool({ limit: 2 });
    await expect(
      pool.run([
        () => Promise.resolve(1),
        () => Promise.reject(new Error("boom")),
        () => Promise.resolve(3),
      ])
    ).rejects.toThrow("boom");
  });

  test("throws for limit < 1", () => {
    expect(() => createPool({ limit: 0 })).toThrow(RangeError);
  });

  test("single task resolves correctly", async () => {
    const pool = createPool({ limit: 1 });
    const results = await pool.run([() => Promise.resolve(42)]);
    expect(results).toEqual([42]);
  });

  test("limit greater than task count works fine", async () => {
    const pool = createPool({ limit: 100 });
    const results = await pool.run([
      () => Promise.resolve("a"),
      () => Promise.resolve("b"),
    ]);
    expect(results).toEqual(["a", "b"]);
  });
});
