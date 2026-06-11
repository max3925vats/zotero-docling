// Small display-formatting helpers shared by the orchestrators.

/**
 * Format a duration in seconds as a compact human string:
 *   42      → "42s"
 *   252     → "4m 12s"
 *   3725    → "1h 2m 5s"  (no seconds when ≥ 1h and seconds == 0)
 *   0/NaN   → "0s"
 *
 * Used for batch-completion toasts so users can see how long a run took
 * without leaving Zotero.
 */
export function formatDuration(totalSec: number | undefined): string {
  if (!Number.isFinite(totalSec) || (totalSec as number) <= 0) return "0s";
  const t = Math.round(totalSec as number);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  const s = t % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return s === 0 ? `${h}h ${mm}m` : `${h}h ${mm}m ${s}s`;
}

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

/**
 * Format a byte count as a compact human string with one decimal:
 *   512        → "512 B"
 *   2_048      → "2.0 KB"
 *   18_874_368 → "18.0 MB"
 *   0/negative/NaN → "0 B"
 *
 * Used by the remove-images toast to report how much bloat was shed.
 */
export function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || (bytes as number) <= 0) return "0 B";
  const b = bytes as number;
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = b;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}
