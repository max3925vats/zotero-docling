// Auto-convert any newly-added PDF attachment.
//
// Zotero.Notifier fires `add` events as items land in the library. We collect
// IDs into a queue and process the queue after a quiet period — this prevents
// hammering docling-serve when the user imports a batch (e.g. drags 20 PDFs at
// once or syncs a folder).
//
// Gated entirely on the `autoConvert` preference; if that pref is false the
// observer returns immediately and nothing happens.

import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { releaseBatch, tryAcquireBatch } from "../utils/batchLock";
import {
  convertAttachment,
  applyStatusTagsToParents,
  preflightServer,
  type ConvertResult,
} from "./convert";
import { toast } from "./ui";
import { ConcurrencyLimiter } from "../utils/concurrencyLimiter";
import { notifyOnBatchComplete } from "../utils/notification";
import { formatDuration } from "../utils/format";

const LOG = "[Docling/notifier]";
const DEBOUNCE_MS = 3000;
// When docling-serve is down, retry queued PDFs every minute, a few times.
const PREFLIGHT_RETRY_MS = 60_000;
const PREFLIGHT_RETRIES = 3;

// Stored on `Zotero` so it survives module reloads from npm-start hot-reload.
// Without this, every rebuild leaks another observer and the notifier fires N
// times per item-add, causing duplicate auto-conversions.
const GLOBAL_KEY = "__zoteroDoclingNotifierID__";

let notifierID: string | null = null;
const pendingIDs = new Set<number>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Stays true while processPending is in flight, so back-to-back batches don't
// trigger overlapping convert loops.
let processing = false;
// Set when we've already told the user "queued, waiting" for the current
// deferral cycle. Prevents spamming a toast every 3-second debounce tick
// while a long manual batch is still in flight. Cleared as soon as we
// actually start processing.
let deferredToastShown = false;
// Consecutive failed server checks for the current queue.
let preflightFailures = 0;

function log(...args: unknown[]): void {
  try {
    ztoolkit.log(LOG, ...args);
  } catch {
    /* ignore */
  }
}

const observer = {
  notify: (
    event: string,
    type: string,
    ids: Array<string | number>,
    _extraData: { [key: string]: any },
  ) => {
    if (event !== "add" || type !== "item") return;
    if (!getPref("autoConvert")) return;

    let queued = 0;
    for (const rawId of ids) {
      const id = typeof rawId === "number" ? rawId : Number(rawId);
      if (!Number.isFinite(id)) continue;
      const item = Zotero.Items.get(id);
      if (!item) continue;
      if ((item.itemType as string) !== "attachment") continue;
      if (item.attachmentContentType !== "application/pdf") continue;
      pendingIDs.add(id);
      queued++;
    }
    if (queued === 0) return;
    log(`queued ${queued} PDF(s); total pending=${pendingIDs.size}`);

    // While waiting to retry an unreachable server, let new PDFs join the
    // scheduled retry: resetting to the short debounce here re-ran the
    // server check early and used up the retries within seconds.
    if (preflightFailures > 0 && debounceTimer) return;
    // Reset the debounce so a steady stream of adds extends the wait.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void processPending();
    }, DEBOUNCE_MS);
  },
};

async function processPending(): Promise<void> {
  if (processing) {
    // The timer that called us has fired; forget it so the running batch's
    // finally (below) sees no pending timer and reschedules for the IDs
    // queued meanwhile. Otherwise they waited for the next import.
    debounceTimer = null;
    log("processPending: already running, will reschedule when it ends");
    return;
  }
  processing = true;
  try {
    const ids = Array.from(pendingIDs);
    if (ids.length === 0) {
      debounceTimer = null;
      return;
    }
    pendingIDs.clear();
    debounceTimer = null;
    log(`processing ${ids.length} pending PDF(s)`);

    // Defer to any batch that's already running (menu, Remove Images). The
    // lock is taken here, synchronously, BEFORE the preflight await — so a
    // menu click during preflight can't start a second batch (audit M2).
    if (!tryAcquireBatch("auto-convert")) {
      log("a batch is already running — re-queueing for next debounce tick");
      // Put the IDs back so we'll process them after the current batch ends.
      for (const id of ids) pendingIDs.add(id);
      // Toast ONCE per deferral cycle so the user knows auto-convert is
      // pending. The flag is cleared as soon as we actually start
      // processing the queued items (below).
      if (!deferredToastShown) {
        const n = pendingIDs.size;
        toast(
          getString("autoconvert-title"),
          getString("autoconvert-queued", { args: { count: n } }),
          true,
        );
        deferredToastShown = true;
      }
      if (!debounceTimer) {
        debounceTimer = setTimeout(() => {
          void processPending();
        }, DEBOUNCE_MS);
      }
      return;
    }
    // We're going to actually process this tick — reset the toast guard
    // so a future deferral can notify the user again.
    deferredToastShown = false;

    let ok = 0;
    let skipped = 0;
    let failed = 0;
    const skipReasons = new Set<string>();
    const failMessages: string[] = [];
    const warnings: string[] = [];
    const batchResults: Array<{ item: Zotero.Item; result: ConvertResult }> =
      [];

    try {
      // Pre-flight: if docling-serve is down, skip the whole batch with one
      // concise toast instead of N "Server not reachable" lines.
      if (!(await preflightServer())) {
        // Keep the PDFs and retry a few times rather than dropping them
        // (they used to be lost until the user converted them by hand).
        preflightFailures++;
        const n = ids.length;
        if (preflightFailures <= PREFLIGHT_RETRIES) {
          for (const id of ids) pendingIDs.add(id);
          // Replace any timer armed meanwhile, so retries never multiply.
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            void processPending();
          }, PREFLIGHT_RETRY_MS);
          log(
            `preflight failed — retry ${preflightFailures}/${PREFLIGHT_RETRIES}`,
          );
          if (preflightFailures === 1) {
            toast(
              getString("autoconvert-title"),
              getString("autoconvert-retrying", { args: { count: n } }),
              false,
            );
          }
        } else {
          preflightFailures = 0;
          toast(
            getString("autoconvert-title"),
            getString("autoconvert-gave-up", { args: { count: n } }),
            false,
          );
        }
        return;
      }
      preflightFailures = 0;

      const limit = Math.max(
        1,
        Math.min(8, Number(getPref("maxConcurrency") ?? 1) || 1),
      );
      const limiter = new ConcurrencyLimiter(limit);

      const runOne = async (id: number): Promise<void> => {
        const item = Zotero.Items.get(id);
        if (!item) return;
        let result: ConvertResult;
        try {
          // Stop sending new PDFs once shutdown has begun (audit M7).
          result = addon.data.alive
            ? await convertAttachment(item)
            : { status: "skipped", reason: "Plugin is shutting down" };
        } catch (e) {
          result = { status: "error", message: (e as Error).message };
          log(`auto-convert threw for item ${id}: ${(e as Error).message}`);
        }
        batchResults.push({ item, result });
        if (result.status === "ok") {
          ok++;
          if (result.warning) warnings.push(result.warning);
        } else if (result.status === "skipped") {
          skipped++;
          skipReasons.add(result.reason);
        } else {
          failed++;
          failMessages.push(result.message);
          log(`auto-convert error for item ${id}: ${result.message}`);
        }
      };

      // allSettled: hold the lock until every item has finished (audit M3).
      await Promise.allSettled(ids.map((id) => limiter.run(() => runOne(id))));
      await applyStatusTagsToParents(batchResults);
    } finally {
      releaseBatch();
    }
    if (ok + failed + skipped === 0) return;

    // Always toast — silent skips left users wondering why nothing happened
    // for standalone PDFs (no parent → skipped).
    const totalSec = batchResults.reduce((acc, { result }) => {
      if (result.status !== "ok") return acc;
      return acc + (result.processingTimeSec ?? 0);
    }, 0);
    const durationSuffix =
      ok > 0 && totalSec > 0 ? ` — took ${formatDuration(totalSec)}` : "";
    const summary = `OK ${ok} · skipped ${skipped} · failed ${failed}${durationSuffix}`;
    const detail =
      failMessages.length > 0
        ? failMessages.slice(0, 2).join("\n")
        : warnings.length > 0
          ? warnings.slice(0, 2).join("\n")
          : skipReasons.size > 0
            ? Array.from(skipReasons).slice(0, 2).join("\n")
            : undefined;
    toast(
      getString("autoconvert-title"),
      detail ? `${summary}\n${detail}` : summary,
      failed === 0,
    );
    notifyOnBatchComplete(
      (getPref("notifyOnComplete") ?? false) as boolean,
      failed === 0
        ? "Docling auto-convert: done"
        : "Docling auto-convert: errors",
      summary,
    );
  } finally {
    processing = false;
    // If more items arrived during processing, kick another debounce tick.
    if (pendingIDs.size > 0 && !debounceTimer) {
      debounceTimer = setTimeout(() => {
        void processPending();
      }, DEBOUNCE_MS);
    }
  }
}

export function registerNotifier(): void {
  // Hot-reload defense: kill any observer left behind by a previous module load.
  const prev = (Zotero as any)[GLOBAL_KEY] as string | undefined;
  if (prev) {
    try {
      Zotero.Notifier.unregisterObserver(prev);
      log("cleaned up previous notifier id=" + prev);
    } catch {
      /* already gone — fine */
    }
    (Zotero as any)[GLOBAL_KEY] = null;
  }
  if (notifierID) return; // shouldn't happen, but be safe

  notifierID = Zotero.Notifier.registerObserver(observer, ["item"]);
  (Zotero as any)[GLOBAL_KEY] = notifierID;
  log("registered notifier id=" + notifierID);
}

export function unregisterNotifier(): void {
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch (e) {
      log("unregister threw:", (e as Error).message);
    }
    notifierID = null;
  }
  (Zotero as any)[GLOBAL_KEY] = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingIDs.clear();
}
