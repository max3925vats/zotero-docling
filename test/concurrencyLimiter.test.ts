import { assert } from "chai";
import { ConcurrencyLimiter } from "../src/utils/concurrencyLimiter";

// Audit M9: when a task finished, the limiter freed its slot and woke the
// next waiter — but the waiter only resumed a microtask later. A fresh run()
// arriving in that gap also got in, so `active` exceeded `limit`. That
// includes the DB-write lock (limit 1), which exists to prevent exactly
// that overlap.

/** Resolve after `n` microtask hops. */
async function hops(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("ConcurrencyLimiter", function () {
  it("never runs more than `limit` tasks, whenever a new task arrives", async function () {
    // Try every arrival point in the hand-off window, not just one.
    for (let k = 0; k <= 10; k++) {
      const limiter = new ConcurrencyLimiter(1);
      let active = 0;
      let maxActive = 0;
      const task = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await hops(3);
        active--;
      };

      let releaseFirst!: () => void;
      const gate = new Promise<void>((r) => (releaseFirst = r));
      const first = limiter.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
      });
      const queued = limiter.run(task); // waits for the slot

      releaseFirst();
      await hops(k);
      const late = limiter.run(task); // arrives during the hand-off

      await Promise.all([first, queued, late]);
      assert.strictEqual(maxActive, 1, `overlap when arriving after ${k} hops`);
    }
  });

  it("runs tasks in arrival order and returns their results", async function () {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await hops(2);
          return n * 10;
        }),
      ),
    );
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(results, [10, 20, 30]);
  });

  it("frees the slot when a task throws", async function () {
    const limiter = new ConcurrencyLimiter(1);
    await limiter
      .run(async () => {
        throw new Error("boom");
      })
      .catch(() => undefined);
    assert.strictEqual(await limiter.run(async () => "next"), "next");
  });

  it("starts waiting tasks at once when setLimit raises the limit", async function () {
    const limiter = new ConcurrencyLimiter(1);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const task = () =>
      limiter.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
      });
    const all = [task(), task(), task()];
    await hops(2);
    limiter.setLimit(3);
    await hops(2);
    const runningAfterRaise = active;
    release();
    await Promise.all(all);
    assert.strictEqual(runningAfterRaise, 3);
    assert.strictEqual(maxActive, 3);
  });

  it("never exceeds a lowered limit once running tasks finish", async function () {
    const limiter = new ConcurrencyLimiter(3);
    let active = 0;
    let maxWhileLaterRan = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = [1, 2, 3].map(() =>
      limiter.run(async () => {
        active++;
        await gate;
        await hops(1);
        active--;
      }),
    );
    await hops(2);
    limiter.setLimit(1);
    const later = [1, 2, 3].map(() =>
      limiter.run(async () => {
        active++;
        maxWhileLaterRan = Math.max(maxWhileLaterRan, active);
        await hops(3);
        active--;
      }),
    );
    release();
    await Promise.all([...first, ...later]);
    // The later tasks only start once the first three are done, one by one.
    assert.strictEqual(maxWhileLaterRan, 1);
  });
});
