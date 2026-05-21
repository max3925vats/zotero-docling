// Small helpers around Zotero.Item that the conversion flow needs.
// Pure logic only — no UI, no fetch, no preferences access.

import { withDbLock } from "./dbLock";

/**
 * True if the parent item already has a markdown child attachment.
 *
 * When `matchPdfFilename` is provided (e.g. "paper.pdf"), only a markdown
 * child whose filename matches the expected output (e.g. "paper.md") counts.
 * This is what skipIfExists wants: when a parent has multiple PDFs, each PDF
 * should be evaluated independently against its OWN expected markdown output,
 * not against any markdown sibling produced by another PDF.
 *
 * When `matchPdfFilename` is omitted, any markdown child triggers a true
 * return (the original any-markdown behavior).
 */
export async function hasMarkdownChild(
  parentItemID: number,
  matchPdfFilename?: string,
): Promise<boolean> {
  const parent = Zotero.Items.get(parentItemID);
  if (!parent) return false;
  const expectedMd = matchPdfFilename
    ? matchPdfFilename.replace(/\.pdf$/i, ".md").toLowerCase()
    : null;
  const childIDs = parent.getAttachments();
  for (const id of childIDs) {
    const child = Zotero.Items.get(id);
    if (!child) continue;
    const fname = (child.attachmentFilename ?? "").toLowerCase();
    if (expectedMd) {
      if (fname === expectedMd) return true;
    } else {
      if (child.attachmentContentType === "text/markdown") return true;
      if (fname.endsWith(".md")) return true;
    }
  }
  return false;
}

/** All PDF attachment children of a parent item. */
export function getPDFAttachments(parentItem: Zotero.Item): Zotero.Item[] {
  const childIDs = parentItem.getAttachments();
  const out: Zotero.Item[] = [];
  for (const id of childIDs) {
    const child = Zotero.Items.get(id);
    if (!child) continue;
    if (child.attachmentContentType === "application/pdf") out.push(child);
  }
  return out;
}

/**
 * Absolute local file path of a stored attachment, or null if the file is
 * not actually present on disk (e.g. cloud-only, not yet synced).
 * Zotero's getFilePath() can return false-y values; we normalise to null.
 */
export async function getLocalFilePath(
  item: Zotero.Item,
): Promise<string | null> {
  const path = item.getFilePath();
  if (!path || typeof path !== "string") return null;
  try {
    const exists = await IOUtils.exists(path);
    return exists ? path : null;
  } catch {
    return null;
  }
}

/**
 * Find a markdown child attachment whose filename matches the expected
 * output for a given PDF filename (paper.pdf → paper.md). Returns the item
 * or null. Case-insensitive on filename.
 */
export function findMatchingMdChild(
  parentItemID: number,
  pdfFilename: string,
): Zotero.Item | null {
  const parent = Zotero.Items.get(parentItemID);
  if (!parent) return null;
  const expected = pdfFilename.replace(/\.pdf$/i, ".md").toLowerCase();
  for (const id of parent.getAttachments()) {
    const child = Zotero.Items.get(id);
    if (!child) continue;
    const fname = (child.attachmentFilename ?? "").toLowerCase();
    if (fname === expected) return child;
  }
  return null;
}

/**
 * Delete the matching .md child if present. Used by the "Re-convert
 * (replace)" path so that a fresh conversion can attach cleanly without
 * stacking a second .md sibling.
 */
export async function removeMatchingMdChild(
  parentItemID: number,
  pdfFilename: string,
): Promise<boolean> {
  const child = findMatchingMdChild(parentItemID, pdfFilename);
  if (!child) return false;
  try {
    await withDbLock(() => child.eraseTx());
    return true;
  } catch {
    return false;
  }
}

/** Convenience: true iff item is a locally-present PDF attachment with a parent. */
export async function isConvertiblePdf(item: Zotero.Item): Promise<boolean> {
  if (!item || (item.itemType as string) !== "attachment") return false;
  if (item.attachmentContentType !== "application/pdf") return false;
  if (!item.parentItemID) return false;
  // LINK_MODE_LINKED_URL means there is no local file — only a URL bookmark.
  if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
    return false;
  }
  const path = await getLocalFilePath(item);
  return path !== null;
}
