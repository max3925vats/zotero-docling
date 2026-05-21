// Small display-formatting helpers shared by the orchestrators.

/**
 * Truncate a string to at most `max` characters. If shortened, replaces the
 * middle with an ellipsis so both the start and the extension survive — useful
 * for PDF filenames like
 *     "very_long_paper_title_with_authors_and_more_stuff.pdf"
 * which becomes
 *     "very_long_paper_…_more_stuff.pdf"
 * at max=40 instead of just chopping the tail.
 */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  const keep = max - 1; // 1 char for "…"
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
