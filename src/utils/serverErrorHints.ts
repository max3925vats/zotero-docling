// Recognise known shapes of docling-serve / Docling / upstream-library
// failure modes in raw error strings, and append a one-line actionable
// hint to the message.
//
// Why this exists: the plugin's failure toast historically surfaces the
// server's verbatim error ("HTTP 500: Cannot convert a MPS Tensor to
// float64 dtype…"). For known patterns we can do better — append a
// short hint pointing at the workaround, so the user doesn't have to
// search the README to recover. The README still owns the long-form
// explanation; this module just points there.
//
// Patterns are evaluated in order. Each matching pattern appends its
// hint once. The function is pure and lives outside convert.ts so it
// can be unit-tested without the Zotero global.

interface KnownIssue {
  /** Short identifier — surfaced in Zotero.debug logs but not the toast. */
  id: string;
  /**
   * Predicate. A RegExp is cheapest; for multi-token AND-matching where
   * order varies, prefer a function (see the MPS entry below).
   */
  matches: (message: string) => boolean;
  /** One-line hint appended after a separator. Keep this short. */
  hint: string;
}

// Order matters only insofar as a single match emits a single hint; if a
// caller ever wants multiple hints from one message, they'll accumulate
// in the order declared here.
export const KNOWN_SERVER_ISSUES: ReadonlyArray<KnownIssue> = [
  {
    id: "mps-float64",
    // RT-DETRv2 in transformers hard-codes a float64 tensor; PyTorch's
    // MPS backend can't represent float64 on Apple Silicon. The two
    // tokens can appear in either order across versions, so match each
    // independently rather than as a fixed phrase.
    matches: (m) => /\bMPS\b/.test(m) && /\bfloat64\b/i.test(m),
    hint: "Apple Silicon MPS bug — restart docling-serve with PYTORCH_ENABLE_MPS_FALLBACK=1 (see README → Troubleshooting).",
  },
  {
    id: "task-result-not-found",
    // docling-serve 1.36 answers a failed *sync* conversion with this 404 and
    // hides the real error (DOCLING_SERVE_DEBUG_ERROR_DETAILS defaults off).
    matches: (m) => /Task result not found/i.test(m),
    hint: "The conversion failed on the server; docling-serve hides the details — check its log.",
  },
];

/**
 * Append known-issue hint(s) to a server error message. If no pattern
 * matches, returns the message unchanged. Multiple matching patterns
 * each append their hint, separated by " · ".
 *
 * Examples:
 *
 *   enrichServerError("HTTP 500: Cannot convert a MPS Tensor to float64 dtype")
 *     → "HTTP 500: Cannot convert a MPS Tensor to float64 dtype
 *        · Apple Silicon MPS bug — restart docling-serve with
 *          PYTORCH_ENABLE_MPS_FALLBACK=1 (see README → Troubleshooting)."
 *
 *   enrichServerError("Server not reachable")
 *     → "Server not reachable"   (unchanged — no known issue matched)
 */
export function enrichServerError(message: string): string {
  if (!message) return message;
  const hints: string[] = [];
  for (const issue of KNOWN_SERVER_ISSUES) {
    try {
      if (issue.matches(message)) hints.push(issue.hint);
    } catch {
      // A broken predicate must never break error surfacing.
    }
  }
  if (hints.length === 0) return message;
  return `${message}\n· ${hints.join("\n· ")}`;
}

// docling-serve reports these for several unrelated causes, so the remote
// hint lists the likely ones rather than guessing one.
const OPAQUE_FAILURE =
  /Task result not found|Internal processing error|Async task failed/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Empty or malformed URL: no host to check, so no Docker note.
    return "";
  }
}

/**
 * Extra hints when a remote picture API is configured: docling-serve gives the
 * same opaque error for all of these, so list the likely causes rather than
 * guess one. Pure (no prefs) so it can be unit-tested.
 */
export function enrichRemotePicError(
  message: string,
  ctx: { enabled: boolean; providerUrl: string },
): string {
  if (!ctx.enabled || !OPAQUE_FAILURE.test(message)) return message;
  const hints = [
    "Remote picture API is on. Likely causes: (1) docling-serve not started with DOCLING_SERVE_ENABLE_REMOTE_SERVICES=true; (2) docling-serve can't reach the API URL from its own machine; (3) the model isn't a vision model or the name is wrong; (4) the remote-API settings are incomplete.",
  ];
  const host = hostOf(ctx.providerUrl);
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    hints.push(
      "If docling-serve runs in Docker, 'localhost' is the container itself — use http://host.docker.internal:<port>/… instead.",
    );
  }
  return `${message}\n· ${hints.join("\n· ")}`;
}
