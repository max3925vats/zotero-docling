// One lock for every long-running batch: menu conversions, auto-convert and
// Remove Images (audit M1–M4). Before this, each orchestrator set and cleared
// its own `batchInFlight` flag at different points, so a throw could leave it
// stuck (blocking every later batch until restart) or one batch could clear
// it while another was still running.
//
// Acquire is synchronous, so the check-and-set can't be split by an `await`.
// Callers must release in a `finally`.

import { getString } from "./locale";

let holder: string | null = null;

/** Take the lock. Returns false (and changes nothing) if it is held. */
export function tryAcquireBatch(owner: string): boolean {
  if (holder !== null) return false;
  holder = owner;
  return true;
}

export function releaseBatch(): void {
  holder = null;
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
