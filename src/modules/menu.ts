// Right-click menu items for Zotero items.
//
//   - "Convert with Docling"              → on any selection that resolves to ≥1 PDF
//   - "Re-convert with Docling (replace)" → same selection, deletes existing
//                                            .md siblings first, force=true.
//                                            Only shown when there's already
//                                            a .md to replace.
//
// Visibility logic + batch orchestration live here. The conversion of an
// individual PDF lives in convert.ts.
//
// No cancel menu — docling-serve has no per-task cancel API (upstream issue
// docling-project/docling-serve#447) and no client-disconnect handling
// (#401), so a client-side abort would just hide a still-running conversion
// from the user without saving any compute. See README "Known limitations".

import { getString } from "../utils/locale";
import {
  convertAttachment,
  applyStatusTagsToParents,
  preflightServer,
  type ConvertResult,
} from "./convert";
import {
  toast,
  startManagedProgress,
  updateManagedHeadline,
  finishManagedProgress,
} from "./ui";
import {
  getPDFAttachments,
  getLocalFilePath,
  removeMatchingMdChild,
  findMatchingMdChild,
} from "../utils/zotero";
import { getPref } from "../utils/prefs";
import { notifyOnBatchComplete } from "../utils/notification";
import { ConcurrencyLimiter } from "../utils/concurrencyLimiter";
import { truncateMiddle } from "../utils/format";

const LOG = "[Docling/menu]";
const MENU_CONVERT_ID = "zotero-docling-convert";
const MENU_RECONVERT_ID = "zotero-docling-reconvert";

function log(...args: unknown[]): void {
  try {
    ztoolkit.log(LOG, ...args);
  } catch {
    /* shutting down */
  }
}

// ---------------------------------------------------------------------------
//  Selection helpers
// ---------------------------------------------------------------------------

/** Z9-safe selection accessor. */
function getSelectedItems(): Zotero.Item[] {
  try {
    const pane = (Zotero as any).getActiveZoteroPane?.();
    return (pane?.getSelectedItems?.() ?? []) as Zotero.Item[];
  } catch (e) {
    log("getActiveZoteroPane threw:", (e as Error).message);
    return [];
  }
}

/**
 * Take whatever's selected and resolve it to a deduped list of PDF
 * attachment items to convert:
 *   - PDF attachments → kept as-is
 *   - Parent items    → expanded to their PDF children
 *   - Anything else   → ignored
 */
function resolvePdfsToConvert(selection: Zotero.Item[]): Zotero.Item[] {
  const seen = new Set<number>();
  const out: Zotero.Item[] = [];
  const push = (item: Zotero.Item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  };
  for (const it of selection) {
    if ((it.itemType as string) === "attachment") {
      if (it.attachmentContentType === "application/pdf") push(it);
    } else {
      for (const child of getPDFAttachments(it)) push(child);
    }
  }
  return out;
}

function shouldShowConvert(): boolean {
  return resolvePdfsToConvert(getSelectedItems()).length > 0;
}

/**
 * Re-convert (replace) is only meaningful when at least one selected PDF
 * already has a matching .md sibling — otherwise it would behave identically
 * to plain Convert and just clutter the menu.
 */
function shouldShowReconvert(): boolean {
  const pdfs = resolvePdfsToConvert(getSelectedItems());
  for (const pdf of pdfs) {
    const parentID = pdf.parentItemID;
    if (!parentID) continue;
    const pdfName = pdf.attachmentFilename ?? "";
    if (!pdfName) continue;
    if (findMatchingMdChild(parentID, pdfName)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
//  Batch orchestration
// ---------------------------------------------------------------------------

/**
 * Run convertAttachment over a resolved PDF list with parallel concurrency,
 * per-item progress, and aggregated status tags + toast.
 * `force` bypasses the skipIfExists guard and pre-deletes existing .md.
 */
async function runBatch(
  pdfs: Zotero.Item[],
  opts: { force: boolean; menuLabel: string },
): Promise<void> {
  // Re-convert (force) only acts on items that actually have a matching .md
  // to replace — otherwise the menu wording "(replace)" would mislead users
  // into thinking selection without existing .md was supposed to be skipped.
  // Plain Convert handles items without .md just fine.
  if (opts.force) {
    pdfs = pdfs.filter((pdf) => {
      const parentID = pdf.parentItemID;
      if (!parentID) return false;
      const pdfName = pdf.attachmentFilename ?? "";
      if (!pdfName) return false;
      return findMatchingMdChild(parentID, pdfName) !== null;
    });
    if (pdfs.length === 0) {
      toast("Docling", "No matching .md files to replace in selection", false);
      return;
    }
  }

  if (pdfs.length === 0) {
    toast("Docling", "No PDF attachments in selection", false);
    return;
  }

  // Only one batch at a time. A second click while a batch is running
  // would otherwise spawn a parallel orchestrator that fights over the
  // shared managed-progress window.
  if (addon.data.batchInFlight) {
    toast(
      "Docling",
      "A conversion batch is already running — wait for it to finish",
      false,
    );
    return;
  }

  // Pre-flight: avoid N×wall-of-error toasts when docling-serve isn't running.
  if (!(await preflightServer())) {
    toast("Docling", "docling-serve isn't running — start it and retry", false);
    return;
  }

  addon.data.batchInFlight = true;

  const limit = Math.max(
    1,
    Math.min(8, Number(getPref("maxConcurrency") ?? 1) || 1),
  );
  const limiter = new ConcurrencyLimiter(limit);

  const total = pdfs.length;
  // Hide the noisy "concurrency=1" suffix when the user is on the default —
  // only surface it when they've actually opted into parallelism.
  const concurrencyNote = limit > 1 ? ` · concurrency=${limit}` : "";
  startManagedProgress(
    `${opts.menuLabel}: converting…`,
    `${total} PDF${total === 1 ? "" : "s"}${concurrencyNote}`,
  );

  let done = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const failureMessages: string[] = [];
  const skipReasons = new Set<string>();
  const batchResults: Array<{ item: Zotero.Item; result: ConvertResult }> = [];

  // Update headline as each item completes — gives the user a live N-of-M
  // counter even when items run in parallel. The managed-progress layer
  // routes this to the visible window if Zotero is focused, or just
  // updates internal state if blurred (focus event will re-show).
  const refreshHeadline = (currentName?: string) => {
    const label = currentName
      ? `${opts.menuLabel}: (${done}/${total}) ${currentName}`
      : `${opts.menuLabel}: (${done}/${total})`;
    updateManagedHeadline(label);
  };

  const runOne = async (item: Zotero.Item): Promise<void> => {
    // For re-convert, delete the matching existing .md attachment first so
    // the fresh conversion doesn't stack a second sibling.
    if (opts.force) {
      const parentID = item.parentItemID;
      const pdfPath = await getLocalFilePath(item);
      if (parentID && pdfPath) {
        await removeMatchingMdChild(parentID, PathUtils.filename(pdfPath));
      }
    }

    // Per-item progress: show this PDF's filename while it's working.
    let displayName = "";
    try {
      const p = await getLocalFilePath(item);
      if (p) displayName = truncateMiddle(PathUtils.filename(p), 40);
    } catch {
      /* best-effort */
    }
    refreshHeadline(displayName);

    let result: ConvertResult;
    try {
      result = await convertAttachment(item, { force: opts.force });
    } catch (e) {
      result = { status: "error", message: (e as Error).message };
    }
    batchResults.push({ item, result });
    if (result.status === "ok") ok++;
    else if (result.status === "skipped") {
      skipped++;
      skipReasons.add(result.reason);
    } else {
      failed++;
      failureMessages.push(result.message);
    }
    done++;
    refreshHeadline();
  };

  try {
    await Promise.all(pdfs.map((item) => limiter.run(() => runOne(item))));
    await applyStatusTagsToParents(batchResults);
  } finally {
    addon.data.batchInFlight = false;
  }

  const allOk = failed === 0;
  const summary = `OK ${ok} · skipped ${skipped} · failed ${failed}`;
  const body =
    failureMessages.length > 0
      ? failureMessages.slice(0, 2).join("\n")
      : skipReasons.size > 0
        ? Array.from(skipReasons).slice(0, 2).join("\n")
        : undefined;
  finishManagedProgress(
    allOk,
    allOk
      ? `${opts.menuLabel}: done`
      : `${opts.menuLabel}: finished with errors`,
    body ? `${summary}\n${body}` : summary,
  );

  // OS notification — only when Zotero isn't focused and pref is on.
  notifyOnBatchComplete(
    (getPref("notifyOnComplete") ?? false) as boolean,
    allOk ? "Docling: done" : "Docling: finished with errors",
    summary,
  );
}

// ---------------------------------------------------------------------------
//  Click handlers
// ---------------------------------------------------------------------------

async function onConvertClick(): Promise<void> {
  log("onConvertClick");
  const selection = getSelectedItems();
  const pdfs = resolvePdfsToConvert(selection);
  log(`convert: selection=${selection.length} → pdfs=${pdfs.length}`);
  await runBatch(pdfs, { force: false, menuLabel: "Docling" });
}

async function onReconvertClick(): Promise<void> {
  log("onReconvertClick");
  const selection = getSelectedItems();
  const pdfs = resolvePdfsToConvert(selection);
  log(`reconvert: selection=${selection.length} → pdfs=${pdfs.length}`);
  await runBatch(pdfs, { force: true, menuLabel: "Docling (replace)" });
}

// ---------------------------------------------------------------------------
//  Registration
// ---------------------------------------------------------------------------

export function registerMenu(): void {
  // Hot-reload safety: kill previous registrations first.
  for (const id of [MENU_CONVERT_ID, MENU_RECONVERT_ID]) {
    try {
      ztoolkit.Menu.unregister(id);
    } catch {
      /* not present — fine */
    }
  }

  // Item right-click: Convert
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: MENU_CONVERT_ID,
    label: getString("menuitem-convert"),
    commandListener: () => {
      void onConvertClick();
    },
    getVisibility: () => shouldShowConvert(),
  });

  // Item right-click: Re-convert (replace) — only when there's already a
  // matching .md to replace, otherwise this duplicates plain Convert.
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: MENU_RECONVERT_ID,
    label: getString("menuitem-reconvert"),
    commandListener: () => {
      void onReconvertClick();
    },
    getVisibility: () => shouldShowReconvert(),
  });

  log(`registerMenu: registered ${MENU_CONVERT_ID}, ${MENU_RECONVERT_ID}`);
}

export function unregisterMenu(): void {
  for (const id of [MENU_CONVERT_ID, MENU_RECONVERT_ID]) {
    try {
      ztoolkit.Menu.unregister(id);
    } catch {
      /* ignore */
    }
  }
}
