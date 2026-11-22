// One lock for every long-running batch: menu conversions, auto-convert and
// Remove Images (audit M1–M4). Before this, each orchestrator set and cleared
// its own `batchInFlight` flag at different points, so a throw could leave it
// stuck (blocking every later batch until restart) or one batch could clear
// it while another was still running.
//
// Acquire is synchronous, so the check-and-set can't be split by an `await`.
// Callers must release in a `finally`.

import { CancelToken } from "./cancel";
import { getString } from "./locale";

let holder: string | null = null;
// Hard stop for the running batch: cancels its client-side waits. Only the
// plugin shutting down fires it (see abortBatch).
let abortToken: CancelToken | null = null;
// Soft stop: the user asked the batch not to start any more PDFs.
let stopRequested = false;

/** Take the lock. Returns false (and changes nothing) if it is held. */
export function tryAcquireBatch(owner: string): boolean {
  if (holder !== null) return false;
  holder = owner;
  abortToken = new CancelToken();
  stopRequested = false;
  return true;
}

export function releaseBatch(): void {
  holder = null;
  abortToken = null;
  stopRequested = false;
}

/** Who holds the lock ("menu", "auto-convert", ...), or null. */
export function batchHolder(): string | null {
  return holder;
}

/**
 * The running batch's abort token, for passing to convertAttachment. A new
 * one per batch, so an abort never leaks into the next batch.
 */
export function batchAbortToken(): CancelToken | undefined {
  return abortToken ?? undefined;
}

/**
 * Ask the running batch to stop starting new PDFs. PDFs already sent to
 * docling-serve still finish and are attached: the server can't cancel
 * them, so abandoning them would waste their compute (README "Known
 * limitations"). Returns false when no batch is running.
 */
export function requestStopBatch(): boolean {
  if (holder === null) return false;
  stopRequested = true;
  return true;
}

/** True once the running batch has been asked to stop or aborted. */
export function isStopRequested(): boolean {
  return stopRequested || (abortToken?.cancelled ?? false);
}

/**
 * Stop the running batch now, including its in-flight waits. For plugin
 * shutdown only: the server keeps converting, but an unloaded plugin can't
 * attach the result anyway.
 */
export function abortBatch(reason: string): void {
  stopRequested = true;
  abortToken?.cancel(reason);
}

export function isBatchRunning(): boolean {
  return holder !== null;
}

/** What to tell a user who was refused because the lock is held. */
export function busyMessage(): string {
  if (holder === "auto-convert") return getString("busy-auto-convert");
  if (holder === "remove-images") return getString("busy-remove-images");
  return getString("busy-batch");
}
