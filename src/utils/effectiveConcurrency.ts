// How many conversions a batch runs at once, from the maxConcurrency pref.
//
// The sync endpoint gets a lower ceiling than async. docling-serve puts sync
// jobs in the same queue as async ones and gives up after
// DOCLING_SERVE_MAX_SYNC_WAIT (120 s by default) counted from submission,
// so time spent waiting in the queue counts against it. Sending more sync
// jobs than the server has workers (DOCLING_SERVE_ENG_LOC_NUM_WORKERS,
// default 2) makes the extra ones time out with a 504 before they start.

/** Upper bound for the pref, whatever the transport. */
export const MAX_CONCURRENCY = 8;

/** Ceiling on the sync endpoint: docling-serve's default worker count. */
export const SYNC_CONCURRENCY_CAP = 2;

/**
 * Extra PDFs a parallel async batch keeps queued at docling-serve. With
 * exactly as many PDFs in flight as the server has workers, a worker sits
 * idle while the plugin downloads a result, attaches it and uploads the
 * next PDF. A couple queued behind keep the workers busy. (Uploads are
 * capped separately in convert.ts.) Not applied when the setting is 1, which
 * means one at a time.
 */
export const ASYNC_PREFETCH = 2;

/**
 * The maxConcurrency pref as a number in [1, MAX_CONCURRENCY]: how many
 * conversions the user asked docling-serve to run at once.
 */
export function requestedConcurrency(raw: unknown): number {
  let n: number;
  try {
    n = Math.floor(Number(raw));
  } catch {
    // Number() throws for values with no usable primitive form (a Symbol,
    // or an object whose toString/valueOf aren't functions).
    return 1;
  }
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_CONCURRENCY, n) : 1;
}

/**
 * Parse the maxConcurrency pref and apply the transport's ceiling (sync) or
 * prefetch (async). Missing, non-numeric and sub-1 values mean 1
 * (sequential); fractions round down.
 */
export function effectiveConcurrency(raw: unknown, useAsync: boolean): number {
  const requested = requestedConcurrency(raw);
  if (!useAsync) return Math.min(requested, SYNC_CONCURRENCY_CAP);
  return requested > 1 ? requested + ASYNC_PREFETCH : requested;
}
