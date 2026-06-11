// Rewrite existing docling markdown attachments in place, replacing every
// embedded/linked image with the `<!-- image -->` placeholder docling emits
// in image_export_mode=placeholder. Retroactive companion to the
// "Exclude images" preference: markdown converted before that option (or
// with it off) carries base64 figures that can dwarf the actual text.
//
// Two UI entry points: right-click on selected items, and the Tools menu
// item "Docling: Remove images from markdown…". Both call
// onRemoveImagesClick().
//
// The rewrite is destructive (the embedded image data is gone for good —
// recoverable only by re-converting the PDF), so a confirm dialog guards it.
// The string transformation itself is pure and lives in
// utils/stripImages.ts; this module only resolves targets and touches disk.

import { toast } from "./ui";
import { getSelectedItems } from "./menu";
import { getLocalFilePath, findMatchingMdChild } from "../utils/zotero";
import { stripImagesFromMarkdown } from "../utils/stripImages";
import { formatBytes } from "../utils/format";

const LOG = "[Docling/removeImages]";

function log(...args: unknown[]): void {
  try {
    ztoolkit.log(LOG, ...args);
  } catch {
    /* shutting down */
  }
}

/** True for attachment items that look like markdown (.md or text/markdown). */
function isMarkdownAttachment(item: Zotero.Item): boolean {
  if ((item.itemType as string) !== "attachment") return false;
  if (item.attachmentContentType === "text/markdown") return true;
  return ((item.attachmentFilename ?? "") as string)
    .toLowerCase()
    .endsWith(".md");
}

/**
 * Resolve a selection to the deduped list of markdown attachments to rewrite:
 *   - markdown attachments     → kept as-is
 *   - PDF attachments          → their matching .md sibling (paper.pdf → paper.md)
 *   - parent items             → matching .md of every PDF child
 *   - anything else            → ignored
 *
 * The pdf→md filename matching mirrors the zip export and skipIfExists rules,
 * so this only targets docling outputs — a hand-written notes.md sibling that
 * doesn't shadow a PDF is left alone unless the user selects it directly.
 *
 * Synchronous on purpose: menu getVisibility callbacks can't await.
 */
export function resolveMdTargets(selection: Zotero.Item[]): Zotero.Item[] {
  const seen = new Set<number>();
  const out: Zotero.Item[] = [];
  const push = (item: Zotero.Item | null) => {
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  };
  const pushMatchingMd = (
    parentID: number | false | undefined,
    pdfName: string,
  ) => {
    if (!parentID || !pdfName) return;
    push(findMatchingMdChild(parentID, pdfName));
  };

  for (const it of selection) {
    if ((it.itemType as string) === "attachment") {
      if (isMarkdownAttachment(it)) {
        push(it);
      } else if (it.attachmentContentType === "application/pdf") {
        pushMatchingMd(it.parentItemID, it.attachmentFilename ?? "");
      }
      continue;
    }
    for (const cid of it.getAttachments?.() ?? []) {
      const child = Zotero.Items.get(cid);
      if (!child) continue;
      if (child.attachmentContentType === "application/pdf") {
        pushMatchingMd(it.id, child.attachmentFilename ?? "");
      }
    }
  }
  return out;
}

/**
 * Confirm before rewriting files in place. Returns true to proceed. Same
 * defensive shape as confirmReconvertWithUser: if the prompt service is
 * unavailable, allow the action rather than silently blocking it.
 */
function confirmRemoveImages(count: number): boolean {
  const Services = (globalThis as any).Services;
  const prompt = Services?.prompt;
  if (!prompt?.confirmEx) return true;

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

  const title = "Remove images from markdown?";
  const body = `This rewrites ${count} markdown attachment${count === 1 ? "" : "s"} in place, replacing every embedded image with a small <!-- image --> placeholder.\n\nThe image data is removed for good — re-convert the PDF if you ever want it back.`;

  let pressed: number;
  try {
    pressed = prompt.confirmEx(
      win,
      title,
      body,
      flags,
      "Remove images", // button 0
      null, // button 1 — title comes from CANCEL flag
      null,
      null,
      { value: false },
    );
  } catch (e) {
    log(`confirm prompt threw, allowing action: ${(e as Error).message}`);
    return true;
  }
  return pressed === 0;
}

/**
 * Right-click and Tools-menu entry point. `source` is just for logging —
 * the logic is identical in both cases.
 */
export async function onRemoveImagesClick(
  source: "selection" | "tools",
): Promise<void> {
  log(`remove-images click source=${source}`);
  const targets = resolveMdTargets(getSelectedItems());
  if (targets.length === 0) {
    toast(
      "Docling",
      "Select items with converted markdown (or .md attachments) first.",
      false,
    );
    return;
  }

  // Don't interleave with a running conversion batch — it may be writing
  // the same .md attachments we're about to rewrite.
  if (addon.data.batchInFlight) {
    toast(
      "Docling",
      "A conversion batch is already running — wait for it to finish",
      false,
    );
    return;
  }

  if (!confirmRemoveImages(targets.length)) return;

  let changed = 0;
  let imagesReplaced = 0;
  let bytesSaved = 0;
  let untouched = 0;
  let failed = 0;

  for (const md of targets) {
    const path = await getLocalFilePath(md);
    if (!path) {
      log(`md ${md.id} has no local file (cloud-only?) — skipping`);
      failed++;
      continue;
    }
    let before: string;
    try {
      before = await IOUtils.readUTF8(path);
    } catch (e) {
      log(`failed to read ${path}: ${(e as Error).message}`);
      failed++;
      continue;
    }
    const { markdown: after, replaced } = stripImagesFromMarkdown(before);
    if (replaced === 0) {
      untouched++;
      continue;
    }
    try {
      await IOUtils.writeUTF8(path, after);
    } catch (e) {
      log(`failed to write ${path}: ${(e as Error).message}`);
      failed++;
      continue;
    }
    changed++;
    imagesReplaced += replaced;
    // Embedded images are base64 (ASCII), so UTF-16 code-unit length is a
    // faithful byte estimate for the part we removed.
    bytesSaved += Math.max(0, before.length - after.length);
    log(`stripped ${replaced} image(s) from ${path}`);
  }

  const detailParts: string[] = [];
  if (untouched > 0) detailParts.push(`${untouched} had no images`);
  if (failed > 0) detailParts.push(`${failed} failed`);
  const detail = detailParts.length > 0 ? ` — ${detailParts.join(", ")}` : "";
  const summary =
    changed > 0
      ? `Replaced ${imagesReplaced} image${imagesReplaced === 1 ? "" : "s"} in ${changed} file${changed === 1 ? "" : "s"}, saving ${formatBytes(bytesSaved)}${detail}`
      : `No images found in ${targets.length} markdown file${targets.length === 1 ? "" : "s"}${detail}`;
  toast("Docling", summary, failed === 0);
}
