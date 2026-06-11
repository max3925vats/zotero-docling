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
import { getPref, setPref } from "../utils/prefs";
import { notifyOnBatchComplete } from "../utils/notification";
import { ConcurrencyLimiter } from "../utils/concurrencyLimiter";
import { truncateMiddle, formatDuration } from "../utils/format";
import { onExportMarkdownZipClick } from "./markdownZipExport";
import { onRemoveImagesClick, resolveMdTargets } from "./removeImages";

const LOG = "[Docling/menu]";
const MENU_CONVERT_ID = "zotero-docling-convert";
const MENU_RECONVERT_ID = "zotero-docling-reconvert";
const MENU_EXPORT_MD_ZIP_ID = "zotero-docling-export-md-zip";
const TOOLS_EXPORT_MD_ZIP_ID = "zotero-docling-tools-export-md-zip";
const MENU_REMOVE_IMAGES_ID = "zotero-docling-remove-images";
const TOOLS_REMOVE_IMAGES_ID = "zotero-docling-tools-remove-images";

// Re-exports — used by other modules (markdownZipExport.ts) that need to
// resolve a Zotero selection in the same way the right-click handlers do.
export { resolvePdfsToConvert, getSelectedItems };

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
 * Show a "Re-convert with Docling?" confirm dialog with a "Don't ask again"
 * checkbox. Returns true if the user confirmed. The destructive Re-convert
 * action deletes the existing .md attachment(s); confirming guards against
 * an accidental click that would cost minutes-to-hours of compute (or API
 * spend, when paired with a remote LLM API).
 *
 * Uses Services.prompt.confirmEx — cross-platform, supports a checkbox
 * natively. If the user ticks "Don't ask again" and confirms, we flip the
 * `confirmReconvert` pref off; the Reset-to-defaults button restores it.
 */
function confirmReconvertWithUser(count: number): boolean {
  const Services = (globalThis as any).Services;
  const prompt = Services?.prompt;
  if (!prompt?.confirmEx) {
    // No prompt service available (very unusual). Default to allowing the
    // action — losing the confirm is preferable to silently blocking the
    // user from re-converting at all.
    return true;
  }

  const Ci = (globalThis as any).Components?.interfaces;
  const STD =
    prompt.BUTTON_TITLE_IS_STRING ??
    Ci?.nsIPromptService?.BUTTON_TITLE_IS_STRING ??
    127;
  const CANCEL =
    prompt.BUTTON_TITLE_CANCEL ??
    Ci?.nsIPromptService?.BUTTON_TITLE_CANCEL ??
    2;
  const POS0 = prompt.BUTTON_POS_0 ?? Ci?.nsIPromptService?.BUTTON_POS_0 ?? 0;
  const POS1 = prompt.BUTTON_POS_1 ?? Ci?.nsIPromptService?.BUTTON_POS_1 ?? 8;
  const flags = STD * POS0 + CANCEL * POS1;

  const win =
    (Zotero as any).getMainWindow?.() ??
    (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView ??
    null;

  const title = "Re-convert with Docling?";
  const body = `This will delete the existing markdown attachment${count === 1 ? "" : "s"} on ${count} selected PDF${count === 1 ? "" : "s"} and run conversion again. Any manual edits to the existing markdown will be lost.`;
  const checkLabel = "Don't ask again";
  const check = { value: false };

  let pressed: number;
  try {
    pressed = prompt.confirmEx(
      win,
      title,
      body,
      flags,
      "Re-convert", // button 0 (left)
      null, // button 1 — title comes from CANCEL flag
      null, // button 2 — unused
      checkLabel,
      check,
    );
  } catch (e) {
    Zotero.debug(
      `${LOG} confirmReconvert prompt threw, allowing action: ${(e as Error).message}`,
    );
    return true;
  }

  // Button index 0 is "Re-convert"; 1 is Cancel.
  if (pressed !== 0) return false;
  if (check.value) {
    try {
      setPref("confirmReconvert", false);
    } catch (e) {
      Zotero.debug(
        `${LOG} confirmReconvert: failed to persist opt-out: ${(e as Error).message}`,
      );
    }
  }
  return true;
}

/**
 * Run convertAttachment over a resolved PDF list with parallel concurrency,
 * per-item progress, and aggregated status tags + toast.
 * `force` bypasses the skipIfExists guard and pre-deletes existing .md.
 *
 * Exported so the markdown zip export "Convert first" path can drive the same
 * orchestrator from outside menu.ts without duplicating the progress-window
 * + batchInFlight + concurrency + tag logic.
 */
export async function runBatch(
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

  // Re-convert is destructive — it deletes existing .md attachments before
  // running a fresh conversion. Confirm with the user unless they've opted
  // out via the "Don't ask again" checkbox. Confirm BEFORE setting any
  // in-flight state so cancelling is a clean no-op.
  if (opts.force && ((getPref("confirmReconvert") ?? true) as boolean)) {
    if (!confirmReconvertWithUser(pdfs.length)) return;
  }

  // Only one batch at a time. A second click while a batch is running
  // would otherwise spawn a parallel orchestrator that fights over the
  // shared managed-progress window.
  //
  // The flag MUST be set synchronously before the first `await` — otherwise
  // two rapid clicks both pass the check, both await the preflight, and
  // both proceed to spawn a batch.
  if (addon.data.batchInFlight) {
    toast(
      "Docling",
      "A conversion batch is already running — wait for it to finish",
      false,
    );
    return;
  }
  addon.data.batchInFlight = true;

  // Pre-flight: avoid N×wall-of-error toasts when docling-serve isn't running.
  if (!(await preflightServer())) {
    addon.data.batchInFlight = false;
    toast("Docling", "docling-serve isn't running — start it and retry", false);
    return;
  }

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
  // Sum docling-serve's reported processing_time across OK items. With
  // concurrency > 1 this is the SUM of work the server did, not the wall
  // time the user waited — still the most honest number we have.
  const totalSec = batchResults.reduce((acc, { result }) => {
    if (result.status !== "ok") return acc;
    return acc + (result.processingTimeSec ?? 0);
  }, 0);
  const durationSuffix =
    ok > 0 && totalSec > 0 ? ` — took ${formatDuration(totalSec)}` : "";
  const summary = `OK ${ok} · skipped ${skipped} · failed ${failed}${durationSuffix}`;
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

const ALL_MENU_IDS = [
  MENU_CONVERT_ID,
  MENU_RECONVERT_ID,
  MENU_EXPORT_MD_ZIP_ID,
  TOOLS_EXPORT_MD_ZIP_ID,
  MENU_REMOVE_IMAGES_ID,
  TOOLS_REMOVE_IMAGES_ID,
];

export function registerMenu(): void {
  // Hot-reload safety: kill previous registrations first.
  for (const id of ALL_MENU_IDS) {
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

  // Item right-click: Export markdown to .zip. Shown whenever
  // the selection resolves to ≥1 PDF — the export handler then handles
  // the missing-md case via a confirm dialog.
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: MENU_EXPORT_MD_ZIP_ID,
    label: getString("menuitem-export-md-zip"),
    commandListener: () => {
      void onExportMarkdownZipClick("selection");
    },
    getVisibility: () => shouldShowConvert(),
  });

  // Tools → Docling: Export markdown to .zip (.zip). Same handler as the
  // right-click but reachable without a selection — falls back to "current
  // library" when nothing is selected.
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: TOOLS_EXPORT_MD_ZIP_ID,
    label: getString("menuitem-tools-export-md-zip"),
    commandListener: () => {
      void onExportMarkdownZipClick("tools");
    },
  });

  // Item right-click: Remove images from markdown — only when the selection
  // resolves to ≥1 markdown attachment to rewrite. The handler re-confirms
  // before touching any file.
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: MENU_REMOVE_IMAGES_ID,
    label: getString("menuitem-remove-images"),
    commandListener: () => {
      void onRemoveImagesClick("selection");
    },
    getVisibility: () => resolveMdTargets(getSelectedItems()).length > 0,
  });

  // Tools → Docling: Remove images from markdown…. Same handler as the
  // right-click; toasts a hint when nothing usable is selected.
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: TOOLS_REMOVE_IMAGES_ID,
    label: getString("menuitem-tools-remove-images"),
    commandListener: () => {
      void onRemoveImagesClick("tools");
    },
  });

  log(`registerMenu: registered ${ALL_MENU_IDS.join(", ")}`);
}

export function unregisterMenu(): void {
  for (const id of ALL_MENU_IDS) {
    try {
      ztoolkit.Menu.unregister(id);
    } catch {
      /* ignore */
    }
  }
}
