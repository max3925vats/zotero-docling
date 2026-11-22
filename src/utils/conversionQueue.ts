// The one queue every conversion batch runs its PDFs through.
//
// Menu batches and auto-convert used to each create their own limiter and
// could not run at the same time, so PDFs imported during a manual batch sat
// idle until it ended, even when it was down to its last PDF. Sharing one
// queue lets them run side by side without exceeding Parallel conversions
// between them. The queue is first come, first served: PDFs added while
// another batch is running start as slots free up.

import { ConcurrencyLimiter } from "./concurrencyLimiter";

export const conversionQueue = new ConcurrencyLimiter(1);
