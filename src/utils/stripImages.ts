// Strip images out of docling-generated markdown, replacing each one with
// the same `<!-- image -->` placeholder comment that docling itself emits
// when image_export_mode=placeholder. Lets users retroactively de-bloat
// markdown that was converted before the "Exclude images" option existed
// (embedded mode inlines every figure as a base64 data URI).
//
// Pure string logic only — no Zotero APIs — so the unit tests in
// test/stripImages.test.ts can exercise it directly. The in-place file
// rewriting orchestrator lives in modules/removeImages.ts.

export const IMAGE_PLACEHOLDER = "<!-- image -->";

/**
 * Markdown image syntax: ![alt](target) with an optional "title". The
 * target match stops at the first `)`, which is correct for everything
 * docling emits (base64 data URIs and artifact paths contain no parens);
 * hand-written URLs with balanced parens are out of scope.
 */
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** Raw HTML <img> tags, with or without a (useless) closing </img>. */
const HTML_IMG_RE = /<img\b[^>]*>(?:\s*<\/img>)?/gi;

/** Opening/closing code-fence line: up to 3 spaces of indent, then ``` or ~~~. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export interface StripImagesResult {
  /** Transformed markdown. Identical to the input when `replaced` is 0. */
  markdown: string;
  /** How many images were replaced with the placeholder. */
  replaced: number;
}

/**
 * Replace every markdown image and HTML <img> tag with IMAGE_PLACEHOLDER,
 * leaving fenced code blocks untouched (a code sample that *shows* image
 * syntax isn't an image). Idempotent: placeholders contain no image syntax,
 * so running twice changes nothing.
 *
 * Replacement is in-place within the line, so images inside table cells
 * keep the table structure intact:
 *   | ![Image](data:image/png;base64,...) |  →  | <!-- image --> |
 */
export function stripImagesFromMarkdown(md: string): StripImagesResult {
  let replaced = 0;
  const swap = () => {
    replaced++;
    return IMAGE_PLACEHOLDER;
  };

  let fenceChar: string | null = null;
  const lines = md.split("\n").map((line) => {
    const fence = line.match(FENCE_RE);
    if (fence) {
      const char = fence[1][0];
      if (fenceChar === null) {
        fenceChar = char; // opening fence
      } else if (char === fenceChar) {
        fenceChar = null; // closing fence (mismatched chars stay open)
      }
      return line;
    }
    if (fenceChar !== null) return line; // inside a code block
    return line.replace(MD_IMAGE_RE, swap).replace(HTML_IMG_RE, swap);
  });

  return replaced === 0
    ? { markdown: md, replaced: 0 }
    : { markdown: lines.join("\n"), replaced };
}
