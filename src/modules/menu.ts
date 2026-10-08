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
  findMatchingMdChild,
} from "../utils/zotero";
import { getPref, setPref } from "../utils/prefs";
import { busyMessage, releaseBatch, tryAcquireBatch } from "../utils/batchLock";
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
    // No prompt service (very unusual). Fail closed: never replace markdown
    // without the user's confirmation.
    Zotero.debug(`${LOG} confirmReconvert: no prompt service — not proceeding`);
    return false;
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

  const title = getString("reconvert-confirm-title");
  // With "Attach to item" off nothing is replaced in Zotero — say so.
  const body = getString(
    ((getPref("attachToItem") ?? true) as boolean)
      ? "reconvert-confirm-body-replace"
      : "reconvert-confirm-body-export",
    { args: { count } },
  );
  const checkLabel = getString("confirm-dont-ask-again");
  const check = { value: false };

  let pressed: number;
  try {
    pressed = prompt.confirmEx(
      win,
      title,
      body,
      flags,
      getString("reconvert-confirm-button"), // button 0 (left)
      null, // button 1 — title comes from CANCEL flag
      null, // button 2 — unused
      checkLabel,
      check,
    );
  } catch (e) {
    Zotero.debug(
      `${LOG} confirmReconvert prompt threw, not proceeding: ${(e as Error).message}`,
    );
    return false;
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
 * + batch lock + concurrency + tag logic.
 */
export async function runBatch(
  pdfs: Zotero.Item[],
  opts: { force: boolean; menuLabel: string },
): Promise<boolean> {
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
      toast("Docling", getString("toast-no-md-to-replace"), false);
      return false;
    }
  }

  if (pdfs.length === 0) {
    toast("Docling", getString("toast-no-pdfs"), false);
    return false;
  }
  // The plugin is being disabled, updated or Zotero is quitting.
  if (!addon.data.alive) return false;

  // Re-convert replaces existing .md attachments (the old ones go to the
  // trash once the new conversion is attached). Confirm with the user
  // unless they've opted out via the "Don't ask again" checkbox. Confirm
  // BEFORE taking the lock so cancelling is a clean no-op.
  if (opts.force && ((getPref("confirmReconvert") ?? true) as boolean)) {
    if (!confirmReconvertWithUser(pdfs.length)) return false;
  }

  // Only one batch at a time (menu, auto-convert and Remove Images share
  // the lock). Acquire is synchronous, so two rapid clicks can't both pass.
  if (!tryAcquireBatch("menu")) {
    toast("Docling", busyMessage(), false);
    return false;
  }

  const total = pdfs.length;
  let done = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const failureMessages: string[] = [];
  const warnings: string[] = [];
  const skipReasons = new Set<string>();
  const batchResults: Array<{ item: Zotero.Item; result: ConvertResult }> = [];

  // Everything after the lock is taken runs inside this try, so the lock is
  // released however the batch ends — including a throw in preflight or
  // progress setup (audit M1). An unexpected throw is reported below rather
  // than leaving the progress window stuck on "converting…".
  let unexpected: Error | null = null;
  try {
    // Pre-flight: avoid N×wall-of-error toasts when docling-serve isn't running.
    if (!(await preflightServer())) {
      toast("Docling", getString("toast-server-not-running"), false);
      return false;
    }

    const limit = Math.max(
      1,
      Math.min(8, Number(getPref("maxConcurrency") ?? 1) || 1),
    );
    const limiter = new ConcurrencyLimiter(limit);

    // Hide the noisy "concurrency=1" suffix when the user is on the default —
    // only surface it when they've actually opted into parallelism.
    const concurrencyNote = limit > 1 ? ` · concurrency=${limit}` : "";
    startManagedProgress(
      `${opts.menuLabel}: converting…`,
      `${total} PDF${total === 1 ? "" : "s"}${concurrencyNote}`,
    );

    // Update headline as each item completes — gives the user a live N-of-M
    // counter even when items run in parallel. Best-effort: a UI hiccup must
    // never abort the batch.
    const refreshHeadline = (currentName?: string) => {
      const label = currentName
        ? `${opts.menuLabel}: (${done}/${total}) ${currentName}`
        : `${opts.menuLabel}: (${done}/${total})`;
      try {
        updateManagedHeadline(label);
      } catch {
        /* progress window gone — keep converting */
      }
    };

    const runOne = async (item: Zotero.Item): Promise<void> => {
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
        // Stop sending new PDFs once shutdown has begun (audit M7).
        result = addon.data.alive
          ? await convertAttachment(item, { force: opts.force })
          : { status: "skipped", reason: "Plugin is shutting down" };
      } catch (e) {
        result = { status: "error", message: (e as Error).message };
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
        failureMessages.push(result.message);
      }
      done++;
      refreshHeadline();
    };

    // allSettled, not all: the lock must stay held until EVERY item has
    // finished, even if one of them throws (audit M3).
    await Promise.allSettled(
      pdfs.map((item) => limiter.run(() => runOne(item))),
    );
    await applyStatusTagsToParents(batchResults);
  } catch (e) {
    unexpected = e as Error;
    log(`batch failed unexpectedly: ${unexpected.message}`);
  } finally {
    releaseBatch();
  }

  if (unexpected) {
    try {
      finishManagedProgress(
        false,
        `${opts.menuLabel}: failed`,
        `OK ${ok} · skipped ${skipped} · failed ${failed}\n${unexpected.message}`,
      );
    } catch {
      toast(
        "Docling",
        getString("toast-batch-failed", {
          args: { message: unexpected.message },
        }),
        false,
      );
    }
    return true;
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
      : warnings.length > 0
        ? warnings.slice(0, 2).join("\n")
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
  return true;
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

// Documents we've already added menu items to. A second load signal for the
// same window (Zotero's own onMainWindowLoad plus our startup pass) would
// otherwise stack another set of popupshowing visibility listeners.
const registeredDocs = new WeakSet<Document>();

/** Remove our menu items from one window's document. */
function removeMenuItems(doc: Document): void {
  for (const id of ALL_MENU_IDS) doc.getElementById(id)?.remove();
}

/**
 * Add our menu items to `win`. Items go into that window's own popups —
 * not `Zotero.getMainWindow()`, which with several main windows open may be
 * a different window (audit review of PR 2).
 */
export function registerMenu(win: Window): void {
  const doc = win.document;
  if (registeredDocs.has(doc)) return;
  const itemPopup = doc.querySelector("#zotero-itemmenu");
  const toolsPopup = doc.querySelector("#menu_ToolsPopup");
  if (!itemPopup || !toolsPopup) return; // window not ready; next load retries
  // Hot-reload safety: drop items left by a previous copy of the plugin.
  removeMenuItems(doc);

  // Item right-click: Convert
  ztoolkit.Menu.register(itemPopup as XULMenuPopupElement, {
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
  ztoolkit.Menu.register(itemPopup as XULMenuPopupElement, {
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
  ztoolkit.Menu.register(itemPopup as XULMenuPopupElement, {
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
  ztoolkit.Menu.register(toolsPopup as XULMenuPopupElement, {
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
  ztoolkit.Menu.register(itemPopup as XULMenuPopupElement, {
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
  ztoolkit.Menu.register(toolsPopup as XULMenuPopupElement, {
    tag: "menuitem",
    id: TOOLS_REMOVE_IMAGES_ID,
    label: getString("menuitem-tools-remove-images"),
    commandListener: () => {
      void onRemoveImagesClick("tools");
    },
  });

  registeredDocs.add(doc);
  log(`registerMenu: registered ${ALL_MENU_IDS.join(", ")}`);
}

/** Remove our menu items from `win` only. */
export function unregisterMenu(win: Window): void {
  removeMenuItems(win.document);
  registeredDocs.delete(win.document);
}
