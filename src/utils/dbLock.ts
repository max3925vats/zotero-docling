// Serialise Zotero DB writes across the plugin.
//
// Why: when maxConcurrency > 1, multiple convertAttachment() calls run in
// parallel and all eventually want to write back to Zotero (importFromFile,
// setField + saveTx, tag mutations + saveTx, eraseTx on stale .md
// siblings). Zotero's SQLite layer doesn't love concurrent transactions
// from the same plugin context — you can get "DB is locked" or stale-data
// errors. Funnelling every write through a single-slot semaphore keeps the
// reads/writes serial without sacrificing parallel network calls to
// docling-serve.
//
// Usage:
//   await withDbLock(() => zoteroItem.saveTx());
//   const att = await withDbLock(() => Zotero.Attachments.importFromFile({...}));

import { ConcurrencyLimiter } from "./concurrencyLimiter";

const dbWriteLock = new ConcurrencyLimiter(1);

export function withDbLock<T>(fn: () => Promise<T>): Promise<T> {
  return dbWriteLock.run(fn);
}
