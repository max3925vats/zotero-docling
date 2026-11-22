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
 * Parse the maxConcurrency pref and apply the transport's ceiling. Missing,
 * non-numeric and sub-1 values mean 1 (sequential); fractions round down.
 */
export function effectiveConcurrency(raw: unknown, useAsync: boolean): number {
  const n = Math.floor(Number(raw));
  const requested =
    Number.isFinite(n) && n >= 1 ? Math.min(MAX_CONCURRENCY, n) : 1;
  return useAsync ? requested : Math.min(requested, SYNC_CONCURRENCY_CAP);
}
