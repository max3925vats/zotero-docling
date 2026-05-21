// Simple promise-based semaphore for limiting how many async tasks run
// concurrently. Used by the conversion orchestrators (menu, notifier) to
// fan out N PDFs to docling-serve in parallel without unbounded parallelism.
//
// Usage:
//   const limiter = new ConcurrencyLimiter(3);
//   const results = await Promise.all(items.map((i) => limiter.run(() => doWork(i))));

export class ConcurrencyLimiter {
  private readonly limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Run `task` when a slot is free; resolves with the task's result. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
