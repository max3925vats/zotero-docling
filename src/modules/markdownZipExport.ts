// Export selected items' converted markdown attachments to a single .zip file.
//
// The zip is flat: each markdown file lives at the root, named after the
// parent's citation key (Better BibTeX) or Zotero key. Multi-PDF parents
// disambiguate with `.1.md`, `.2.md` etc.
//
// Two UI entry points: right-click on selected items, and the Tools menu
// item "Docling: Export markdown to .zip…". Both call
// onExportMarkdownZipClick().
//
// Missing-md handling: if any selected item lacks a converted .md, we
// surface a three-button confirm — Skip and export / Convert first /
// Cancel. "Convert first" delegates to menu.ts:runBatch and waits before
// proceeding to zip, so the user gets a single managed-progress window.

import JSZip from "jszip";

import { toast } from "./ui";
import { runBatch, resolvePdfsToConvert, getSelectedItems } from "./menu";
import { getLocalFilePath } from "../utils/zotero";

const LOG = "[Docling/zip]";

function log(...args: unknown[]): void {
  try {
    ztoolkit.log(LOG, ...args);
  } catch {
    /* shutting down */
  }
}

// ---------------------------------------------------------------------------
//  Pure helpers (tested in test/markdownZipExport.test.ts)
// ---------------------------------------------------------------------------

/**
 * Pick the base filename for an item's markdown in the zip. Mirrors the
 * `exportBaseName` logic in convert.ts so an item exported through this
 * path lands with the same name it would under `exportFolderPath`.
 *
 * citationKey (Better BibTeX field) wins; falls back to the extra-field
 * "Citation Key:" line; then to the Zotero stable key; then to "unknown".
 * Filesystem-hostile characters are stripped.
 */
export function zipBaseName(parent: Zotero.Item | null): string {
  if (!parent) return "unknown";
  let citationKey = (
    (parent.getField?.("citationKey") as string | undefined) ?? ""
  ).trim();
  if (!citationKey) {
    const extra = (parent.getField?.("extra") as string | undefined) ?? "";
    const m = extra.match(/^Citation Key:\s*(\S+)/m);
    if (m) citationKey = m[1];
  }
  const safe = (citationKey || parent.key || "unknown").replace(
    /[\\/:*?"<>|]/g,
    "_",
  );
  return safe;
}

/**
 * Pick a unique zip-path for an item, suffixing `.1`, `.2`, … when more
 * than one PDF under the same parent would otherwise collide on the same
 * base name. The `taken` set is mutated to record the chosen name so
 * repeated calls within a single export remain stable.
 *
 *   zipUniqueName("vaswani17", taken)           → "vaswani17.md"
 *   zipUniqueName("vaswani17", taken)  // again → "vaswani17.1.md"
 *   zipUniqueName("vaswani17", taken)  // again → "vaswani17.2.md"
 */
export function zipUniqueName(base: string, taken: Set<string>): string {
  const primary = `${base}.md`;
  if (!taken.has(primary)) {
    taken.add(primary);
    return primary;
  }
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}.${i}.md`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Pathological — 1000 PDFs under one parent. Fall back to a key-suffixed
  // name so we never throw.
  const fallback = `${base}.${Date.now()}.md`;
  taken.add(fallback);
  return fallback;
}

/** ISO-8601 date (YYYY-MM-DD) for the default zip filename. */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
//  Item resolution
// ---------------------------------------------------------------------------

/**
 * A row in our internal export plan: the parent item, the PDF we'd convert
 * from, and (when present) the existing markdown child. `mdChild` is null
 * when no conversion has happened yet — handled by the missing-md dialog.
 */
interface ZipRow {
  parent: Zotero.Item;
  pdf: Zotero.Item;
  mdChild: Zotero.Item | null;
}

/**
 * For each selected PDF, find its parent and matching `.md` sibling.
 * Items without a parent are dropped (you can't have a citation key
 * without one). The pdf.md filename matching is case-insensitive and
 * follows the same rule as `findMatchingMdChild`.
 */
function planExport(pdfs: Zotero.Item[]): ZipRow[] {
  const out: ZipRow[] = [];
  for (const pdf of pdfs) {
    const parentID = pdf.parentItemID;
    if (!parentID) continue;
    const parent = Zotero.Items.get(parentID);
    if (!parent) continue;
    const pdfName = (pdf.attachmentFilename ?? "").toLowerCase();
    const expectedMd = pdfName.replace(/\.pdf$/i, ".md");
    let mdChild: Zotero.Item | null = null;
    for (const cid of parent.getAttachments()) {
      const child = Zotero.Items.get(cid);
      if (!child) continue;
      const cname = (child.attachmentFilename ?? "").toLowerCase();
      if (cname === expectedMd) {
        mdChild = child;
        break;
      }
    }
    out.push({ parent, pdf, mdChild });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Confirm dialog (3 buttons: Skip and export / Convert first / Cancel)
// ---------------------------------------------------------------------------

type MissingMdChoice = "skip" | "convert" | "cancel";

/**
 * Three-button prompt when some items lack markdown. Returns the user's
 * choice. `Services.prompt.confirmEx` supports exactly three buttons via
 * BUTTON_POS_{0,1,2} flags, which is what this dialog needs.
 */
function promptMissingMd(missing: number, total: number): MissingMdChoice {
  const Services = (globalThis as any).Services;
  const prompt = Services?.prompt;
  if (!prompt?.confirmEx) return "skip"; // no prompt service → safe default

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
  const POS2 = prompt.BUTTON_POS_2 ?? Ci?.nsIPromptService?.BUTTON_POS_2 ?? 16;
  // Buttons: 0 = Skip and export, 1 = Convert first, 2 = Cancel
  const flags = STD * POS0 + STD * POS1 + CANCEL * POS2;

  const win =
    (Zotero as any).getMainWindow?.() ??
    (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView ??
    null;

  const title = "Export markdown to .zip";
  const body = `${missing} of ${total} selected PDF${total === 1 ? "" : "s"} have no Docling markdown yet.\n\nHow would you like to proceed?`;

  let pressed: number;
  try {
    pressed = prompt.confirmEx(
      win,
      title,
      body,
      flags,
      "Skip and export",
      "Convert first",
      null,
      null,
      { value: false },
    );
  } catch (e) {
    log(`promptMissingMd threw, defaulting to skip: ${(e as Error).message}`);
    return "skip";
  }
  if (pressed === 0) return "skip";
  if (pressed === 1) return "convert";
  return "cancel";
}

// ---------------------------------------------------------------------------
//  Native file-save dialog
// ---------------------------------------------------------------------------

/**
 * Show a Save As dialog and return the chosen absolute path, or null if
 * the user cancelled.
 *
 * Goes through Zotero's FilePicker module (via the toolkit helper) rather
 * than raw nsIFilePicker: Firefox 128+ (Zotero 8) requires a
 * BrowsingContext as the first argument to nsIFilePicker.init, and
 * Zotero's wrapper absorbs that difference across supported versions.
 */
async function promptSavePath(defaultName: string): Promise<string | null> {
  let picked: string | false;
  try {
    picked = await new ztoolkit.FilePicker(
      "Save markdown .zip",
      "save",
      [["Zip archive", "*.zip"]],
      defaultName,
    ).open();
  } catch (e) {
    log(`save dialog failed: ${(e as Error).message}`);
    return null;
  }
  if (!picked) return null;
  // Force the .zip extension if the user typed one without it.
  return /\.zip$/i.test(picked) ? picked : `${picked}.zip`;
}

// ---------------------------------------------------------------------------
//  Zip generation
// ---------------------------------------------------------------------------

interface BuildResult {
  zipBytes: Uint8Array;
  exported: number;
  skipped: number;
  failedReads: number;
}

async function buildZip(rows: ZipRow[]): Promise<BuildResult> {
  const zip = new JSZip();
  const taken = new Set<string>();
  let exported = 0;
  let skipped = 0;
  let failedReads = 0;

  for (const row of rows) {
    if (!row.mdChild) {
      skipped++;
      continue;
    }
    const path = await getLocalFilePath(row.mdChild);
    if (!path) {
      log(
        `mdChild ${row.mdChild.id} has no local file (cloud-only?) — skipping`,
      );
      failedReads++;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await IOUtils.read(path);
    } catch (e) {
      log(`failed to read md ${path}: ${(e as Error).message}`);
      failedReads++;
      continue;
    }
    const base = zipBaseName(row.parent);
    const entryName = zipUniqueName(base, taken);
    zip.file(entryName, bytes);
    exported++;
  }

  const zipBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { zipBytes, exported, skipped, failedReads };
}

// ---------------------------------------------------------------------------
//  Orchestrator
// ---------------------------------------------------------------------------

/**
 * Right-click and Tools-menu entry point. `source` is just for logging
 * — the logic is identical in both cases.
 */
export async function onExportMarkdownZipClick(
  source: "selection" | "tools",
): Promise<void> {
  log(`export click source=${source}`);
  const selection = getSelectedItems();
  const pdfs = resolvePdfsToConvert(selection);
  if (pdfs.length === 0) {
    toast(
      "Docling",
      "Select one or more items (or PDF attachments) to export.",
      false,
    );
    return;
  }

  let rows = planExport(pdfs);
  if (rows.length === 0) {
    toast(
      "Docling",
      "Selected PDFs have no parent items — cannot export.",
      false,
    );
    return;
  }

  const missing = rows.filter((r) => !r.mdChild).length;
  if (missing > 0) {
    const choice = promptMissingMd(missing, rows.length);
    if (choice === "cancel") return;
    if (choice === "convert") {
      // Drive the existing batch orchestrator over only the PDFs that
      // need it. runBatch handles its own progress window, status tags,
      // and batchInFlight guard. We re-plan afterwards to pick up the
      // freshly-created .md children.
      const needs = rows.filter((r) => !r.mdChild).map((r) => r.pdf);
      await runBatch(needs, { force: false, menuLabel: "Docling" });
      rows = planExport(pdfs);
      const stillMissing = rows.filter((r) => !r.mdChild).length;
      if (stillMissing === rows.length) {
        toast(
          "Docling",
          "Conversion produced no markdown — nothing to export.",
          false,
        );
        return;
      }
    }
    // "skip" falls through with the original `rows`; buildZip drops the
    // mdChild=null entries.
  }

  const defaultName = `docling-markdown-${todayIsoDate()}.zip`;
  const outPath = await promptSavePath(defaultName);
  if (!outPath) {
    log("user cancelled save dialog");
    return;
  }

  toast(
    "Docling",
    `Building zip with ${rows.length} item${rows.length === 1 ? "" : "s"}…`,
    true,
  );
  let built: BuildResult;
  try {
    built = await buildZip(rows);
  } catch (e) {
    toast("Docling", `Failed to build zip: ${(e as Error).message}`, false);
    return;
  }

  try {
    await IOUtils.write(outPath, built.zipBytes);
  } catch (e) {
    toast("Docling", `Failed to write zip: ${(e as Error).message}`, false);
    return;
  }

  const detailParts: string[] = [];
  if (built.skipped > 0) detailParts.push(`${built.skipped} skipped (no .md)`);
  if (built.failedReads > 0)
    detailParts.push(`${built.failedReads} unreadable`);
  const detail = detailParts.length > 0 ? ` — ${detailParts.join(", ")}` : "";
  toast(
    "Docling",
    `Exported ${built.exported} markdown file${built.exported === 1 ? "" : "s"} to ${outPath}${detail}`,
    built.exported > 0,
  );
}
