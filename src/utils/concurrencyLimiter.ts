// Simple promise-based semaphore for limiting how many async tasks run
// concurrently. Used by the conversion orchestrators (menu, notifier) to
// fan out N PDFs to docling-serve in parallel without unbounded parallelism.
//
// Usage:
//   const limiter = new ConcurrencyLimiter(3);
//   const results = await Promise.all(items.map((i) => limiter.run(() => doWork(i))));

export class ConcurrencyLimiter {
  private limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /**
   * Change the limit. Raising it starts waiting tasks straight away;
   * lowering it lets running tasks finish and starts no more until the
   * count is under the new limit.
   */
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    while (this.active < this.limit && this.queue.length > 0) {
      this.active++;
      this.queue.shift()!();
    }
  }

  /** Run `task` when a slot is free; resolves with the task's result. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // Wait for a finishing task to hand its slot over (see finally).
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      // Pass the slot straight to the next waiter without freeing it. Freeing
      // first (active--) left a gap before the waiter resumed in which a new
      // run() could also take the slot, exceeding the limit (audit M9). If
      // setLimit() lowered the limit below the running count, free the slot
      // instead.
      const next = this.active <= this.limit ? this.queue.shift() : undefined;
      if (next) next();
      else this.active--;
    }
  }
}
