// The lock for long-running batches: menu conversions, auto-convert and
// Remove Images (audit M1–M4). Before it, each orchestrator set and cleared
// its own `batchInFlight` flag at different points, so a throw could leave it
// stuck (blocking every later batch until restart) or one batch could clear
// it while another was still running.
//
// Conversion batches ("menu", "auto-convert") share the lock: they feed one
// conversion queue (conversionQueue.ts), so auto-convert can use slots a
// manual batch leaves free, and a manual batch can start while auto-convert
// runs. Each owner holds it at most once, so a second manual batch is still
// refused while one runs. Any other owner ("remove-images") holds it alone:
// it rewrites .md files a conversion may be writing.
//
// Acquire is synchronous, so the check-and-set can't be split by an `await`.
// Callers must release in a `finally`.

import { CancelToken } from "./cancel";
import { getString } from "./locale";

/** Owners that share the lock with each other. */
const CONVERSION_OWNERS = new Set(["menu", "auto-convert"]);

const holders = new Set<string>();
// Hard stop for running conversions: cancels their client-side waits. Only
// the plugin shutting down fires it (see abortBatch). One token while any
// holder is in, so a shutdown reaches every batch.
let abortToken: CancelToken | null = null;
// Soft stop: owners asked not to start any more PDFs. Per owner, so a batch
// that starts after the request isn't stopped too.
const stopped = new Set<string>();

function isShared(owner: string): boolean {
  return CONVERSION_OWNERS.has(owner);
}

/** Take the lock. Returns false (and changes nothing) if it can't be had. */
export function tryAcquireBatch(owner: string): boolean {
  if (holders.has(owner)) return false;
  if (holders.size > 0) {
    if (!isShared(owner)) return false;
    for (const h of holders) if (!isShared(h)) return false;
  }
  if (holders.size === 0) abortToken = new CancelToken();
  holders.add(owner);
  stopped.delete(owner);
  return true;
}

/** Release `owner`'s hold, or every hold when called without one (tests). */
export function releaseBatch(owner?: string): void {
  if (owner === undefined) holders.clear();
  else holders.delete(owner);
  if (owner === undefined) stopped.clear();
  else stopped.delete(owner);
  if (holders.size === 0) abortToken = null;
}

/** True while a conversion batch (menu or auto-convert) holds the lock. */
export function isConversionRunning(): boolean {
  for (const h of holders) if (isShared(h)) return true;
  return false;
}

/**
 * The running batches' abort token, for passing to convertAttachment. A new
 * one each time the lock goes from free to held, so an abort never leaks
 * into a later batch.
 */
export function batchAbortToken(): CancelToken | undefined {
  return abortToken ?? undefined;
}

/**
 * Ask every running conversion batch to stop starting new PDFs. PDFs
 * already sent to docling-serve still finish and are attached: the server
 * can't cancel them, so abandoning them would waste their compute (README
 * "Known limitations"). Returns false when no conversion batch was running
 * unstopped.
 */
export function requestStopBatch(): boolean {
  let any = false;
  for (const h of holders) {
    if (isShared(h) && !stopped.has(h)) {
      stopped.add(h);
      any = true;
    }
  }
  return any;
}

/** True while a conversion batch runs that hasn't been asked to stop. */
export function hasUnstoppedConversion(): boolean {
  for (const h of holders) if (isShared(h) && !stopped.has(h)) return true;
  return false;
}

/**
 * True once `owner`'s batch has been asked to stop, or the lock aborted.
 * Without an owner: true if any holder was asked to stop.
 */
export function isStopRequested(owner?: string): boolean {
  if (abortToken?.cancelled) return true;
  return owner === undefined ? stopped.size > 0 : stopped.has(owner);
}

/**
 * Stop every running batch now, including in-flight waits. For plugin
 * shutdown only: the server keeps converting, but an unloaded plugin can't
 * attach the result anyway.
 */
export function abortBatch(reason: string): void {
  for (const h of holders) stopped.add(h);
  abortToken?.cancel(reason);
}

export function isBatchRunning(): boolean {
  return holders.size > 0;
}

/** What to tell a user who was refused because the lock is held. */
export function busyMessage(): string {
  if (holders.has("remove-images")) return getString("busy-remove-images");
  if (holders.has("menu")) return getString("busy-batch");
  if (holders.has("auto-convert")) return getString("busy-auto-convert");
  return getString("busy-batch");
}
