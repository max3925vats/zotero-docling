// Core conversion flow: read PDF → POST to docling-serve → attach .md back.
//
// All docling-serve options live in plugin prefs (see addon/prefs.js). They are
// flattened into individual multipart form fields here; there is NO `options`
// JSON blob — the server schema is flat.
//
// Verified against docling-serve 1.18.0 on 2026-05.

import { getPref, setPref } from "../utils/prefs";
import {
  hasMarkdownChild,
  getLocalFilePath,
  isConvertiblePdf,
  mdNameForPdf,
  findMatchingMdChild,
  trashItem,
} from "../utils/zotero";
import {
  buildFrontmatter,
  stripExistingFrontmatter,
} from "../utils/frontmatter";
import { withDbLock } from "../utils/dbLock";
import { ConcurrencyLimiter } from "../utils/concurrencyLimiter";
import { enrichServerError } from "../utils/serverErrorHints";
import { toast } from "./ui";
import { RequestTimeoutError, withRequestTimeout } from "../utils/timeout";
import { CancelledError, sleep, type CancelToken } from "../utils/cancel";
import { batchAbortToken, isStopRequested } from "../utils/batchLock";
import { getString } from "../utils/locale";

const LOG = "[zotero-docling]";

/**
 * Diagnostic logger that emits to BOTH the Browser Toolbox console
 * (ztoolkit.log) AND Zotero's debug log (Zotero.debug). Lets the user see
 * diagnostic lines like "transport=async" without opening Help → Debug Output.
 */
function log(...args: unknown[]): void {
  try {
    ztoolkit.log(LOG, ...args);
  } catch {
    /* ztoolkit not yet available */
  }
  try {
    Zotero.debug(`${LOG} ${args.map((a) => String(a)).join(" ")}`);
  } catch {
    /* shutting down */
  }
}

/**
 * Build the auth header(s) to send with every request based on the configured
 * `authScheme` pref. Returns an empty object when scheme is "none" (the default).
 *
 * Wire format:
 *   - bearer:  Authorization: Bearer <token>
 *   - basic:   Authorization: Basic <base64(username:password)>
 *   - custom:  <header-name>: <header-value>  (single header, v1)
 *
 * The `Zotero.Prefs` store is plain text inside the user's profile — surface
 * this in the prefs help and SECURITY.md rather than pretending it's secure.
 */
/** UTF-8 bytes of a string (lone surrogates become U+FFFD, never a throw). */
function utf8Bytes(s: string): Uint8Array | number[] {
  const Encoder = (globalThis as any).TextEncoder;
  if (Encoder) return new Encoder().encode(s);
  // Sandbox without TextEncoder: same result via encodeURIComponent.
  const safe = s.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "\ufffd",
  );
  return Array.from(
    encodeURIComponent(safe).replace(/%([0-9A-F]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    ),
  ).map((c) => c.charCodeAt(0));
}

export function buildAuthHeader(): Record<string, string> {
  const scheme = ((getPref("authScheme") ?? "none") as string).toLowerCase();
  if (scheme === "none" || scheme === "") return {};

  if (scheme === "bearer") {
    const token = ((getPref("authSecret") as string) ?? "").trim();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  if (scheme === "basic") {
    const user = ((getPref("authUsername") as string) ?? "").trim();
    const pass = (getPref("authSecret") as string) ?? "";
    if (!user && !pass) return {};
    // Basic auth is base64 of the UTF-8 bytes. btoa() only takes Latin-1, so
    // non-ASCII credentials (é, €, ...) were mis-encoded or threw outright.
    const bytes = utf8Bytes(`${user}:${pass}`);
    let latin1 = "";
    for (const b of bytes) latin1 += String.fromCharCode(b);
    const encoded = (globalThis as any).btoa(latin1);
    return { Authorization: `Basic ${encoded}` };
  }

  if (scheme === "custom") {
    const name = ((getPref("authHeaderName") as string) ?? "").trim();
    const value = ((getPref("authSecret") as string) ?? "").trim();
    if (!name || !value) return {};
    return { [name]: value };
  }

  return {};
}

// Test seam: in-Zotero tests swap `fetch` for a scripted stand-in for
// docling-serve so conversion paths can be exercised without a server.
// Production code never sets this.
let fetchOverrideForTests: typeof fetch | null = null;
export function setFetchOverrideForTests(fn: typeof fetch | null): void {
  fetchOverrideForTests = fn;
}

/**
 * Z9's plugin sandbox exposes some Web APIs as bare globals (e.g. fetch) but
 * not others (e.g. FormData, Blob). Prefer bare globals when present, fall
 * back to a window context when not.
 */
export function getWebApis(): {
  FormData: typeof FormData;
  Blob: typeof Blob;
  fetch: typeof fetch;
  AbortController?: typeof AbortController;
} {
  const g = globalThis as any;
  const win =
    (Zotero as any).getMainWindow?.() ??
    (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;

  const FormDataCtor = g.FormData ?? win?.FormData;
  const BlobCtor = g.Blob ?? win?.Blob;
  const fetchFn =
    fetchOverrideForTests ??
    g.fetch ??
    (win?.fetch ? win.fetch.bind(win) : undefined);

  if (!FormDataCtor || !BlobCtor || !fetchFn) {
    throw new Error(
      `Web API unavailable — FormData=${!!FormDataCtor} Blob=${!!BlobCtor} fetch=${!!fetchFn}`,
    );
  }
  // Take AbortController from the same realm as fetch: a signal from one
  // realm isn't guaranteed to be honoured by a fetch from another.
  // (A test override runs in this realm too.) If the fetch's realm has no
  // AbortController we fall back to the other realm's; the timeout race still
  // rejects on time, but the underlying request may then not be cancelled.
  const fetchIsLocal = !!(fetchOverrideForTests || g.fetch);
  const AbortCtor = fetchIsLocal
    ? (g.AbortController ?? win?.AbortController)
    : (win?.AbortController ?? g.AbortController);
  return {
    FormData: FormDataCtor,
    Blob: BlobCtor,
    fetch: fetchFn,
    AbortController: AbortCtor,
  };
}

export type ConvertResult =
  | {
      status: "ok";
      attachmentID: number;
      processingTimeSec?: number;
      /** Set when the .md was attached but a secondary output failed. */
      warning?: string;
    }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string };

/**
 * Tracks PDF attachment IDs that have a conversion currently in flight,
 * across all orchestrators (menu + notifier). If a second convert call
 * lands for the same item while the first is still running we skip the
 * duplicate — otherwise docling-serve happily processes both and we end
 * up with two .md siblings.
 *
 * Why this exists alongside the batch lock (utils/batchLock.ts): the lock
 * prevents two batches starting simultaneously at the orchestrator level
 * (one click → one batch). This per-item set provides defence-in-depth
 * against future call paths that bypass the batch orchestrator and call
 * `convertAttachment` directly — e.g. a new auto-convert trigger, a unit
 * test, or a future cancel-and-retry feature. The two guards protect
 * different layers, so both stay.
 */
const inFlightItems = new Set<number>();

/**
 * The upload for one conversion. The transport clears `form` once the PDF
 * has been sent, so a conversion waiting on docling-serve doesn't keep its
 * PDF in memory for the minutes or hours the server takes.
 */
interface UploadPayload {
  form: FormData | null;
}

/**
 * PDFs uploaded to the async endpoint at once, across all batches. In async
 * mode a batch keeps more conversions in flight than the server runs (see
 * effectiveConcurrency), so uploads are capped separately to keep them from
 * competing for bandwidth.
 */
const MAX_PARALLEL_UPLOADS = 2;
const uploadLimiter = new ConcurrencyLimiter(MAX_PARALLEL_UPLOADS);

/** docling-serve response envelope (subset we read). */
interface ConvertResponse {
  /** FastAPI request errors (e.g. 422): a message or a list of {msg};
   *  proxies and custom handlers sometimes send an object. */
  detail?: unknown;
  document?: {
    filename?: string;
    md_content?: string;
  };
  status?:
    | "pending"
    | "started"
    | "success"
    | "partial_success"
    | "failure"
    | "skipped";
  errors?: Array<{
    component_type?: string;
    module_name?: string;
    error_message?: string;
  }>;
  processing_time?: number;
}

/**
 * Build the multipart body for POST /v1/convert/file by reading all relevant
 * prefs and turning them into flat form fields. The `advancedJson` pref is
 * merged last, so it overrides anything else.
 *
 * Exported only so the unit tests in test/ can exercise the pref-to-form
 * mapping without going through the network path.
 */
export function buildConvertForm(
  pdfBytes: Uint8Array,
  filename: string,
  api: { FormData: typeof FormData; Blob: typeof Blob },
): FormData {
  const form = new api.FormData();
  form.append(
    "files",
    new api.Blob([pdfBytes], { type: "application/pdf" }),
    filename,
  );

  // Always request markdown — that's the whole point of the plugin.
  form.append("to_formats", "md");
  form.append("abort_on_error", "false");

  // --- Tier 1: essentials ---
  form.append("pipeline", String(getPref("pipeline") ?? "standard"));
  form.append("do_ocr", String(getPref("doOcr") ?? true));
  form.append("force_ocr", String(getPref("forceOcr") ?? false));
  form.append("table_mode", String(getPref("tableMode") ?? "accurate"));

  // Markdown image handling. "embedded" (the server default) inlines every
  // figure as a base64 data URI, which can bloat a paper's .md by tens of
  // megabytes. excludeImages swaps in "placeholder" — each image becomes a
  // tiny <!-- image --> comment, leaving text and tables only.
  form.append(
    "image_export_mode",
    ((getPref("excludeImages") ?? false) as boolean)
      ? "placeholder"
      : "embedded",
  );

  // --- Tier 2: enrichments ---
  form.append(
    "do_formula_enrichment",
    String(getPref("doFormulaEnrichment") ?? false),
  );
  form.append(
    "do_code_enrichment",
    String(getPref("doCodeEnrichment") ?? false),
  );
  form.append(
    "do_chart_extraction",
    String(getPref("doChartExtraction") ?? false),
  );
  form.append(
    "do_picture_classification",
    String(getPref("doPictureClassification") ?? false),
  );

  // --- Tier 3: VLM (only meaningful when pipeline=vlm or doPictureDescription) ---
  const vlmPreset = resolvePreset("vlmPreset", "vlmPresetCustom");
  if (vlmPreset) form.append("vlm_pipeline_preset", vlmPreset);

  const doPicDesc = (getPref("doPictureDescription") ?? false) as boolean;
  form.append("do_picture_description", String(doPicDesc));
  if (doPicDesc) {
    const picPreset = resolvePreset(
      "pictureDescriptionPreset",
      "pictureDescriptionPresetCustom",
    );
    if (picPreset) form.append("picture_description_preset", picPreset);
  }

  // ocr_lang is a repeated field — server reads it as a list
  const ocrLangRaw = (getPref("ocrLang") ?? "") as string;
  for (const lang of ocrLangRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    form.append("ocr_lang", lang);
  }

  // --- Tier 4: advanced JSON merge ---
  const advRaw = (getPref("advancedJson") ?? "") as string;
  if (advRaw.trim().length > 0) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(advRaw);
    } catch (e) {
      throw new Error(
        `advancedJson preference is not valid JSON: ${(e as Error).message}`,
        { cause: e },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("advancedJson must be a JSON object");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue;
      // Remove any earlier value we set for this key so advanced wins.
      form.delete(key);
      if (Array.isArray(value)) {
        for (const v of value) form.append(key, String(v));
      } else if (typeof value === "object") {
        form.append(key, JSON.stringify(value));
      } else {
        form.append(key, String(value));
      }
    }
  }

  return form;
}

/** Status tags applied to the PARENT item after a batch of conversions. */
const TAG_DONE = "docling/done";
const TAG_INCOMPLETE = "docling/incomplete";
const TAG_ERROR = "docling/error";
const ALL_STATUS_TAGS = [TAG_DONE, TAG_INCOMPLETE, TAG_ERROR];
/** Parents saved per status-tag transaction. */
const STATUS_TAG_CHUNK = 50;

/**
 * Aggregate a batch of (item, result) pairs by parent item and apply exactly
 * one status tag per parent — replacing any previous docling/* tag. Skipped
 * results don't change the existing tag (a re-run that's all-skipped leaves
 * a previous docling/done untouched).
 *
 * Tag scheme:
 *   - all OK (no errors)        → docling/done
 *   - some OK + some errors     → docling/incomplete
 *   - all errors (no OK)        → docling/error
 *   - all skipped               → no change
 *
 * Parents are saved in one transaction per STATUS_TAG_CHUNK rather than one
 * each, so a large batch doesn't end with hundreds of transactions in a row.
 * Parents that already carry exactly the right tag aren't saved at all. If a
 * chunk's transaction fails, its parents are retried one at a time so one
 * bad item can't cost the rest their tags.
 */
export async function applyStatusTagsToParents(
  results: Array<{ item: Zotero.Item; result: ConvertResult }>,
): Promise<void> {
  type Stats = { ok: number; error: number; skipped: number };
  const perParent = new Map<number, Stats>();

  for (const { item, result } of results) {
    const parentID = item.parentItemID;
    if (!parentID) continue;
    const s = perParent.get(parentID as number) ?? {
      ok: 0,
      error: 0,
      skipped: 0,
    };
    if (result.status === "ok") s.ok++;
    else if (result.status === "error") s.error++;
    else s.skipped++;
    perParent.set(parentID as number, s);
  }

  const updates: Array<{ parent: Zotero.Item; tag: string }> = [];
  for (const [parentID, s] of perParent) {
    if (s.ok === 0 && s.error === 0) continue; // all-skipped — leave existing tag
    const tag =
      s.error === 0 ? TAG_DONE : s.ok === 0 ? TAG_ERROR : TAG_INCOMPLETE;
    const parent = Zotero.Items.get(parentID);
    if (!parent) continue;
    const current = ALL_STATUS_TAGS.filter((t) => parent.hasTag(t));
    if (current.length === 1 && current[0] === tag) continue; // already right
    updates.push({ parent, tag });
  }

  const retag = ({ parent, tag }: { parent: Zotero.Item; tag: string }) => {
    for (const t of ALL_STATUS_TAGS) parent.removeTag(t);
    parent.addTag(tag, 0);
  };

  for (let i = 0; i < updates.length; i += STATUS_TAG_CHUNK) {
    const chunk = updates.slice(i, i + STATUS_TAG_CHUNK);
    try {
      await withDbLock(() =>
        Zotero.DB.executeTransaction(async () => {
          for (const u of chunk) {
            retag(u);
            await u.parent.save();
          }
        }),
      );
    } catch (e) {
      Zotero.debug(
        `${LOG} applyStatusTags chunk failed, retrying one by one: ${(e as Error).message}`,
      );
      for (const u of chunk) {
        try {
          await withDbLock(async () => {
            retag(u);
            await u.parent.saveTx();
          });
        } catch (err) {
          Zotero.debug(
            `${LOG} applyStatusTags parent=${u.parent.id} failed (non-fatal): ${(err as Error).message}`,
          );
        }
      }
    }
  }
}

/** Concise "errors[]" rendering for surfacing in toasts and logs. */
function formatServerErrors(data: ConvertResponse): string {
  const parts = (data.errors ?? [])
    .map((e) => e?.error_message ?? JSON.stringify(e))
    .filter(Boolean);
  // Request-level errors (bad option, missing field) come back as FastAPI's
  // `detail` rather than `errors`.
  if (parts.length === 0 && data.detail) {
    const d = data.detail;
    if (typeof d === "string") parts.push(d);
    else if (Array.isArray(d)) {
      parts.push(
        ...d.map((x) =>
          typeof x?.msg === "string" ? x.msg : JSON.stringify(x),
        ),
      );
    } else parts.push(JSON.stringify(d));
  }
  return parts.join(" | ") || `status="${data.status ?? "unknown"}"`;
}

// ---------------------------------------------------------------------------
//  Talk to docling-serve — sync or async transport
// ---------------------------------------------------------------------------

type FetchOutcome =
  | { ok: true; data: ConvertResponse }
  | { ok: false; message: string; cancelled?: true };

/** Outcome for a request cut short by the batch's abort token. */
function cancelledOutcome(e: CancelledError): FetchOutcome {
  return { ok: false, message: e.message, cancelled: true };
}

interface TaskStatusResponse {
  task_id?: string;
  task_status?:
    | "pending"
    | "started"
    | "success"
    | "partial_success"
    | "failure"
    | "skipped";
  task_position?: number | null;
  error_message?: string | null;
}

/** Build the response label "HTTP 504 Gateway Timeout" for a Response. */
function httpLabelOf(r: Response): string {
  return r.statusText ? `HTTP ${r.status} ${r.statusText}` : `HTTP ${r.status}`;
}

/**
 * The preset name to send for a preset menu. "Custom…" ("__custom__") means
 * "use the typed name"; with nothing typed we send no preset at all (the
 * server's default) rather than the placeholder (audit M10). Any other value
 * — a known preset, or a custom name saved by an older version — is sent
 * as-is.
 */
function resolvePreset(
  menuKey: "vlmPreset" | "pictureDescriptionPreset",
  customKey: "vlmPresetCustom" | "pictureDescriptionPresetCustom",
): string {
  const value = ((getPref(menuKey) as string) ?? "default").trim();
  if (value !== "__custom__") return value;
  return ((getPref(customKey) as string) ?? "").trim();
}

/**
 * Async max wait in ms. 0 means no limit: docling-serve can't cancel a task,
 * so giving up client-side only orphans it, and some users would rather the
 * plugin wait as long as the server works (README, commit 4ba5ace). Unset
 * or invalid values get the 240-minute default; the maximum is 1440.
 */
export function asyncMaxWaitMs(raw: unknown): number {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "") return 240 * 60_000;
  if (!Number.isFinite(n) || n < 0) return 240 * 60_000;
  if (n === 0) return Infinity;
  return Math.min(1440, Math.max(1, n)) * 60_000;
}

/**
 * Read a timeout pref as milliseconds. Non-numeric or non-positive values
 * fall back to the shipped default rather than disabling the timeout.
 */
function timeoutMs(
  key:
    | "healthTimeoutSec"
    | "pollTimeoutSec"
    | "asyncUploadTimeoutMin"
    | "asyncResultTimeoutMin"
    | "syncTimeoutMin",
  fallback: number,
): number {
  const n = Number(getPref(key));
  const value = Number.isFinite(n) && n > 0 ? n : fallback;
  // setTimeout treats anything above 2^31-1 ms (~24.8 days) as 0, which
  // would make every request "time out" at once.
  return Math.min(value * (key.endsWith("Sec") ? 1000 : 60_000), 2_147_483_647);
}

/** User-facing message for a failed request: timeout vs. unreachable. */
function requestFailureMessage(
  e: unknown,
  what: string,
  settingLabel: string,
): string {
  if (e instanceof RequestTimeoutError) {
    // A timeout stops the waiting, not the work: docling-serve has no cancel
    // API, so say so rather than imply the conversion was stopped.
    return `${e.message} ${what} — docling-serve may still be processing this PDF (Settings → Advanced → Timeouts → ${settingLabel})`;
  }
  return "Server not reachable";
}

/** Parse a response as JSON. On non-2xx with no JSON body, return the HTTP label. */
async function parseConvertResponse(r: Response): Promise<FetchOutcome> {
  const label = httpLabelOf(r);
  let data: ConvertResponse = {};
  let raw = "";
  try {
    raw = await r.text();
    if (raw) data = JSON.parse(raw) as ConvertResponse;
  } catch {
    if (!r.ok) return { ok: false, message: label };
    return {
      ok: false,
      message: `Non-JSON response (${label}): ${raw.slice(0, 200)}`,
    };
  }
  if (!r.ok) {
    const errs = formatServerErrors(data);
    const hasDetail = errs && !errs.startsWith("status=");
    const raw = hasDetail ? `${label}: ${errs}` : label;
    return { ok: false, message: enrichServerError(raw) };
  }
  return { ok: true, data };
}

/** Sync transport: POST + immediate response. */
async function fetchConvertResultSync(
  serverUrl: string,
  payload: UploadPayload,
  api: ReturnType<typeof getWebApis>,
  cancel?: CancelToken,
): Promise<FetchOutcome> {
  try {
    return await withRequestTimeout(
      timeoutMs("syncTimeoutMin", 10),
      async (signal) => {
        const response = await api.fetch(`${serverUrl}/v1/convert/file`, {
          method: "POST",
          body: payload.form,
          headers: buildAuthHeader(),
          signal,
        });
        return parseConvertResponse(response);
      },
      api.AbortController,
      cancel,
    );
  } catch (e) {
    if (e instanceof CancelledError) return cancelledOutcome(e);
    Zotero.debug(`${LOG} sync fetch failed: ${(e as Error).message}`);
    return {
      ok: false,
      message: requestFailureMessage(
        e,
        "waiting for the conversion",
        "Sync conversion",
      ),
    };
  }
}

/**
 * The gap before the next async status check: double the last one, up to
 * the configured poll interval. Exported for tests.
 */
export function pollAfterMs(lastGapMs: number, pollMs: number): number {
  return Math.min(pollMs, Math.max(1, lastGapMs) * 2);
}

/**
 * Async transport: submit job → poll status → fetch result.
 * Avoids upstream proxy/gateway timeouts on long VLM conversions.
 */
async function fetchConvertResultAsync(
  serverUrl: string,
  payload: UploadPayload,
  api: ReturnType<typeof getWebApis>,
  cancel?: CancelToken,
): Promise<FetchOutcome> {
  const pollSec = Math.max(
    1,
    Number(getPref("asyncPollIntervalSec") ?? 5) || 5,
  );
  // Absolute client-side wait ceiling. Does NOT cancel the server-side task
  // (no upstream cancel API; see file header). Bounded [1, 1440] minutes; the
  // pref UI also clamps these.
  const maxWaitMs = asyncMaxWaitMs(getPref("asyncMaxWaitMin"));

  // 1. Submit (at most MAX_PARALLEL_UPLOADS at once; the upload timeout
  // starts once this upload's turn comes)
  const authHeaders = buildAuthHeader();
  let submitBody: TaskStatusResponse;
  try {
    const submitted = await uploadLimiter.run(() =>
      withRequestTimeout(
        timeoutMs("asyncUploadTimeoutMin", 5),
        async (signal) => {
          const r = await api.fetch(`${serverUrl}/v1/convert/file/async`, {
            method: "POST",
            body: payload.form,
            headers: authHeaders,
            signal,
          });
          if (!r.ok) {
            // Include the server's reason (e.g. a 422 for an option set in
            // Advanced JSON), not just the status line.
            const outcome = await parseConvertResponse(r);
            return { label: outcome.ok ? httpLabelOf(r) : outcome.message };
          }
          return {
            body: (await r.json().catch(() => ({}))) as TaskStatusResponse,
          };
        },
        api.AbortController,
        cancel,
      ),
    );
    if ("label" in submitted) {
      return { ok: false, message: `Submit ${submitted.label}` };
    }
    submitBody = submitted.body;
    // Uploaded: let the PDF go while docling-serve works on it.
    payload.form = null;
  } catch (e) {
    if (e instanceof CancelledError) return cancelledOutcome(e);
    Zotero.debug(`${LOG} async submit failed: ${(e as Error).message}`);
    return {
      ok: false,
      message: requestFailureMessage(e, "uploading the PDF", "Async upload"),
    };
  }
  const taskId = submitBody.task_id;
  if (!taskId) {
    return { ok: false, message: "Async submit returned no task_id" };
  }
  log(`async task submitted id=${taskId}`);

  // 2. Poll until terminal or the client-side wait ceiling expires.
  //
  // Two safety nets, neither of which is a server-side cancel (still blocked
  // upstream on docling-serve#447/#401, see README "Known limitations"):
  //
  //   (a) `asyncMaxWaitMin` is an absolute ceiling on how long we'll keep
  //       polling for one task. When exceeded we return — the server-side
  //       task may still be running, but we stop spinning client-side.
  //   (b) `consecutiveFailures` escalates: a Zotero.debug warning at 3
  //       failures, and a single toast at 10. Gives users a fast feedback
  //       loop when docling-serve dies mid-task, instead of appearing hung.
  //
  // Checks start 1 s after submit and the gap doubles up to the configured
  // interval (see pollAfterMs), so a short PDF is picked up within about a
  // second of finishing instead of a full interval later. Each check also
  // asks the server to hold the request until the task finishes (`wait`);
  // docling-serve's Ray engine does, its local and RQ engines answer at
  // once, and then we sleep out the rest of the gap as before.
  const startedAt = Date.now();
  const pollMs = pollSec * 1000;
  let gapMs = Math.min(1000, pollMs);
  let delayMs = gapMs;
  let consecutiveFailures = 0;
  let unresponsiveToastShown = false;
  while (true) {
    // The batch's abort token cuts the sleep short on shutdown, so this
    // loop never outlives the plugin. The server task keeps running.
    try {
      if (delayMs > 0) await sleep(delayMs, cancel);
    } catch (e) {
      if (e instanceof CancelledError) return cancelledOutcome(e);
      throw e;
    }

    if (Date.now() - startedAt > maxWaitMs) {
      return {
        ok: false,
        message: `Async task exceeded maxWait (${maxWaitMs / 60_000} min) — server-side task may still be running`,
      };
    }

    // The next check comes one (longer) gap after this one. A held request
    // (long-poll) shortens the sleep below.
    gapMs = pollAfterMs(gapMs, pollMs);
    delayMs = gapMs;
    const askedAt = Date.now();
    let poll:
      { ok: false; label: string } | { ok: true; status: TaskStatusResponse };
    try {
      poll = await withRequestTimeout(
        // The server may hold the request for up to `wait` seconds.
        timeoutMs("pollTimeoutSec", 30) + pollMs,
        async (signal) => {
          const r = await api.fetch(
            `${serverUrl}/v1/status/poll/${taskId}?wait=${pollSec}`,
            { headers: authHeaders, signal },
          );
          if (!r.ok) {
            // 5xx/429 from a proxy or a busy server are usually transient:
            // throw so the catch below counts a failed poll and keeps going
            // (bounded by the max-wait ceiling). Other errors (404 = task
            // unknown) are final.
            if (r.status >= 500 || r.status === 429) {
              throw new Error(`Poll ${httpLabelOf(r)}`);
            }
            return { ok: false as const, label: httpLabelOf(r) };
          }
          const raw = await r.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = undefined;
          }
          // e.g. a proxy's HTML login page, or `null` — used to poll silently
          // for hours (or crash); now a failed poll.
          if (!parsed || typeof parsed !== "object") {
            throw new Error("Poll returned an unexpected (non-JSON) response");
          }
          return { ok: true as const, status: parsed as TaskStatusResponse };
        },
        api.AbortController,
        cancel,
      );
      consecutiveFailures = 0;
    } catch (e) {
      if (e instanceof CancelledError) return cancelledOutcome(e);
      // A poll that times out counts as one failed poll, like a network blip.
      consecutiveFailures++;
      Zotero.debug(
        `${LOG} async poll failed (${consecutiveFailures} consecutive): ${(e as Error).message}`,
      );
      if (consecutiveFailures === 3) {
        Zotero.debug(
          `${LOG} async poll failing repeatedly — task=${taskId} (will surface a toast at 10)`,
        );
      }
      if (consecutiveFailures >= 10 && !unresponsiveToastShown) {
        unresponsiveToastShown = true;
        try {
          toast(
            "Docling",
            "docling-serve appears unresponsive — async task may have failed",
            false,
          );
        } catch {
          /* toast helpers may fail during shutdown — best-effort */
        }
      }
      // Keep polling until the maxWait ceiling above; transient blips often
      // recover within a few seconds.
      continue;
    }
    if (!poll.ok) {
      return { ok: false, message: `Poll ${poll.label}` };
    }
    const status = poll.status;
    const s = status.task_status;
    if (s === "success" || s === "partial_success") break;
    if (s === "failure") {
      return {
        ok: false,
        message: status.error_message
          ? `Async task failed: ${status.error_message}`
          : "Async task failed",
      };
    }
    if (s === "skipped") {
      return { ok: false, message: "Async task skipped by server" };
    }
    // pending / started / undefined → keep polling. If the server held the
    // request (long-poll), only sleep out what's left of the gap.
    delayMs = Math.max(0, delayMs - (Date.now() - askedAt));
  }

  // 3. Fetch result
  try {
    return await withRequestTimeout(
      timeoutMs("asyncResultTimeoutMin", 10),
      async (signal) => {
        const r = await api.fetch(`${serverUrl}/v1/result/${taskId}`, {
          headers: authHeaders,
          signal,
        });
        return parseConvertResponse(r);
      },
      api.AbortController,
      cancel,
    );
  } catch (e) {
    if (e instanceof CancelledError) return cancelledOutcome(e);
    Zotero.debug(`${LOG} async result fetch failed: ${(e as Error).message}`);
    return {
      ok: false,
      message:
        e instanceof RequestTimeoutError
          ? requestFailureMessage(
              e,
              "downloading the result",
              "Async result download",
            )
          : "Server not reachable while fetching result",
    };
  }
}

/** Dispatch to sync or async transport based on the useAsyncEndpoint pref. */
async function fetchConvertResult(
  serverUrl: string,
  payload: UploadPayload,
  api: ReturnType<typeof getWebApis>,
  cancel?: CancelToken,
): Promise<FetchOutcome> {
  const useAsync = (getPref("useAsyncEndpoint") ?? false) as boolean;
  log(`transport=${useAsync ? "async" : "sync"}`);
  return useAsync
    ? fetchConvertResultAsync(serverUrl, payload, api, cancel)
    : fetchConvertResultSync(serverUrl, payload, api, cancel);
}

/**
 * Convert a single PDF attachment item.
 * Caller is responsible for any UI feedback AND for applying status tags
 * (call `applyStatusTagsToParents` after a batch) — this function only
 * returns the per-attachment result.
 *
 * `cancel` (the batch's abort token) stops the client-side wait and skips
 * every write to Zotero; the result is then "skipped" with its reason.
 */
export async function convertAttachment(
  item: Zotero.Item,
  options?: { force?: boolean; cancel?: CancelToken },
): Promise<ConvertResult> {
  // Dedupe: if a conversion for this exact attachment is already running
  // somewhere, skip the duplicate rather than queueing a second one.
  if (inFlightItems.has(item.id)) {
    return { status: "skipped", reason: "Already converting" };
  }
  inFlightItems.add(item.id);
  try {
    return await convertAttachmentInner(item, options);
  } finally {
    inFlightItems.delete(item.id);
  }
}

/**
 * Convert one PDF of `owner`'s running batch, or skip it if that batch was
 * told to stop before this PDF started. Shared by the menu and auto-convert
 * batches.
 */
export async function convertOrSkip(
  item: Zotero.Item,
  owner: "menu" | "auto-convert",
  force = false,
): Promise<ConvertResult> {
  // Stop sending new PDFs once shutdown has begun (audit M7).
  if (!addon.data.alive) {
    return { status: "skipped", reason: "Plugin is shutting down" };
  }
  if (isStopRequested(owner)) {
    return { status: "skipped", reason: getString("batch-stopped-reason") };
  }
  return convertAttachment(item, { force, cancel: batchAbortToken() });
}

async function convertAttachmentInner(
  item: Zotero.Item,
  options?: { force?: boolean; cancel?: CancelToken },
): Promise<ConvertResult> {
  const force = options?.force ?? false;
  const cancel = options?.cancel;
  if (cancel?.cancelled) {
    return { status: "skipped", reason: cancel.reason ?? "Cancelled" };
  }

  // --- 1. Guard checks ---
  if (!(await isConvertiblePdf(item))) {
    return {
      status: "skipped",
      reason: "Not a locally-stored PDF attachment with a parent item",
    };
  }
  const parentItemID = item.parentItemID as number;

  // --- 2. Resolve local file (needed early for the filename-aware skip) ---
  const pdfPath = await getLocalFilePath(item);
  if (!pdfPath) {
    return { status: "error", message: "PDF file not available locally" };
  }
  const filename = PathUtils.filename(pdfPath);

  // --- 3. Skip-if-exists ---
  // Match on filename so siblings under the same parent don't shadow each
  // other: paper.pdf only skips if paper.md already exists.
  // The `force` option bypasses this check entirely — used by the
  // "Re-convert (replace)" menu so users can intentionally regenerate.
  const skipIfExists = (getPref("skipIfExists") ?? true) as boolean;
  if (
    !force &&
    skipIfExists &&
    (await hasMarkdownChild(parentItemID, filename))
  ) {
    return { status: "skipped", reason: "Markdown attachment already exists" };
  }

  // Re-convert: remember the current .md now, but leave it in place until the
  // replacement is attached — a failed conversion must not cost the user
  // their existing markdown (audit H3).
  const previousMd = force ? findMatchingMdChild(parentItemID, filename) : null;

  // --- 4. Resolve the server ---
  const normalizedUrl = normalizeServerUrl(
    (getPref("serverUrl") as string) ?? "",
  );
  if (!normalizedUrl.ok) {
    return { status: "error", message: normalizedUrl.message };
  }
  const serverUrl = normalizedUrl.url;

  let api: ReturnType<typeof getWebApis>;
  try {
    api = getWebApis();
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }

  // --- 5. Read bytes + build form ---
  const read = await readPdfForm(pdfPath, filename, api);
  if ("error" in read) return { status: "error", message: read.error };
  const payload: UploadPayload = { form: read.form };

  // --- 6. Talk to docling-serve via sync or async transport ---
  log(`send ${serverUrl} file=${filename}`);
  const outcome = await fetchConvertResult(serverUrl, payload, api, cancel);
  payload.form = null;
  if (!outcome.ok) {
    return outcome.cancelled
      ? { status: "skipped", reason: outcome.message }
      : { status: "error", message: outcome.message };
  }
  // Aborted after the result arrived: write nothing to Zotero.
  if (cancel?.cancelled) {
    return { status: "skipped", reason: cancel.reason ?? "Cancelled" };
  }
  const data = outcome.data;

  const okStatus =
    data.status === "success" || data.status === "partial_success";
  if (!okStatus) {
    const raw = `Conversion ${data.status ?? "unknown"}: ${formatServerErrors(data)}`;
    return {
      status: "error",
      message: enrichServerError(raw),
    };
  }
  const rawMarkdown = data.document?.md_content;
  if (typeof rawMarkdown !== "string" || rawMarkdown.length === 0) {
    return { status: "error", message: "Server returned empty md_content" };
  }

  // --- 7. Optionally prepend YAML frontmatter built from parent's metadata ---
  // If the server returned markdown that already begins with a YAML block
  // (rare on docling-serve 1.18.0 but possible if a future server-side
  // post-processor adds one), strip it before prepending our own so we don't
  // end up with two `---` blocks.
  const addFrontmatter = (getPref("addFrontmatter") ?? true) as boolean;
  // Items.get returns `false` (not null) for a missing ID, so `??` would not
  // catch it — normalise to null for the helpers below.
  const parentItem = Zotero.Items.get(parentItemID) || null;
  const fm = addFrontmatter ? buildFrontmatter(parentItem) : "";
  const body = fm ? stripExistingFrontmatter(rawMarkdown) : rawMarkdown;
  const markdown = fm ? `${fm}\n${body}` : body;

  // --- 8. Resolve output destinations ---
  // Two independent sinks: the Zotero attachment (always default on) and an
  // optional filesystem export folder. If both are disabled the run is a
  // skipped no-op (user explicitly asked for nothing).
  const attachToItem = (getPref("attachToItem") ?? true) as boolean;
  const exportFolder = ((getPref("exportFolderPath") as string) ?? "").trim();

  if (!attachToItem && !exportFolder) {
    return {
      status: "skipped",
      reason: "No output target — enable attachToItem or set exportFolderPath",
    };
  }

  // --- 9. Write markdown to a temp file (canonical, then teed to outputs) ---
  // Per-item subdir keeps the expected filename (paper.md) so the Zotero
  // attachment's attachmentFilename matches what hasMarkdownChild expects on
  // subsequent skipIfExists checks.
  const mdName = mdNameForPdf(filename);
  const tmpDir = PathUtils.join(PathUtils.tempDir, `zd-${item.key}`);
  const tmpPath = PathUtils.join(tmpDir, mdName);
  try {
    await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true });
    await IOUtils.writeUTF8(tmpPath, markdown);
  } catch (e) {
    await IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});
    return {
      status: "error",
      message: `Failed to write temp file: ${(e as Error).message}`,
    };
  }

  // --- 10. Import as a Zotero attachment (if enabled) ---
  // Both the import and the follow-up setField/saveTx go through the global
  // DB lock — parallel batches (maxConcurrency > 1) otherwise race on
  // SQLite transactions and intermittently fail.
  let attachmentID: number | undefined;
  if (attachToItem) {
    let newAttachment: Zotero.Item;
    try {
      newAttachment = await withDbLock(() =>
        Zotero.Attachments.importFromFile({
          file: tmpPath,
          parentItemID,
          contentType: "text/markdown",
        }),
      );
    } catch (e) {
      await IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});
      return {
        status: "error",
        message: `Failed to import attachment: ${(e as Error).message}`,
      };
    }
    try {
      await withDbLock(async () => {
        newAttachment.setField("title", mdName);
        await newAttachment.saveTx();
      });
    } catch (e) {
      Zotero.debug(
        `${LOG} title set failed (non-fatal): ${(e as Error).message}`,
      );
    }
    attachmentID = newAttachment.id;

    if (previousMd && previousMd.id !== newAttachment.id) {
      try {
        await trashItem(previousMd);
      } catch (e) {
        // The new .md is attached; a leftover old copy is untidy, not lost.
        Zotero.debug(
          `${LOG} trashing previous .md failed (non-fatal): ${(e as Error).message}`,
        );
      }
    }
  }

  // --- 11. Export to filesystem folder (if configured) ---
  // Naming: citationKey when set on the parent (BBT), else parent's Zotero key.
  // Two PDFs under one parent will produce the same export filename — last
  // write wins. Documented in the README.
  //
  // Written to a per-item temp file and moved into place, so the export is
  // always one complete conversion. With Parallel conversions > 1, two PDFs
  // under one parent write this path at the same time; a direct write could
  // interleave them, and a folder watcher (Obsidian, an indexer) could read
  // a half-written file.
  let exportWarning: string | undefined;
  if (exportFolder) {
    let exportTmpPath: string | undefined;
    try {
      await IOUtils.makeDirectory(exportFolder, { ignoreExisting: true });
      const exportName = `${exportBaseName(parentItem)}.md`;
      const exportPath = PathUtils.join(exportFolder, exportName);
      exportTmpPath = `${exportPath}.${item.key}.tmp`;
      await IOUtils.writeUTF8(exportPath, markdown, { tmpPath: exportTmpPath });
      log(`exported ${exportPath}`);
    } catch (e) {
      if (exportTmpPath) {
        await IOUtils.remove(exportTmpPath, { ignoreAbsent: true }).catch(
          () => {},
        );
      }
      const message = `Failed to write to export folder: ${(e as Error).message}`;
      Zotero.debug(`${LOG} ${message}`);
      // If the export folder was the only output, the conversion produced
      // nothing the user can reach — that's a failure, not a success
      // (audit M5). If the .md was attached, succeed but say so.
      if (!attachToItem) {
        await IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});
        return { status: "error", message };
      }
      exportWarning = message;
    }
  }

  // --- 12. Best-effort cleanup of the per-item temp subdir ---
  await IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});

  Zotero.debug(
    `${LOG} ok item=${item.key} md=${markdown.length}b in ${data.processing_time ?? "?"}s`,
  );
  return {
    status: "ok",
    attachmentID: attachmentID ?? -1,
    processingTimeSec:
      typeof data.processing_time === "number"
        ? data.processing_time
        : undefined,
    warning: exportWarning,
  };
}

/**
 * Read a PDF and build its upload form. The bytes stay local to this
 * function: the form's Blob holds its own copy, so once the transport drops
 * the form after uploading, nothing keeps the PDF in memory.
 */
async function readPdfForm(
  pdfPath: string,
  filename: string,
  api: ReturnType<typeof getWebApis>,
): Promise<{ form: FormData } | { error: string }> {
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await IOUtils.read(pdfPath);
  } catch (e) {
    return { error: `Failed to read PDF: ${(e as Error).message}` };
  }
  try {
    return { form: buildConvertForm(pdfBytes, filename, api) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Pick the base filename for the export-to-folder output. citationKey wins
 * (BetterBibTeX populates this) over the raw Zotero key. Returns at least
 * a usable string — never empty.
 */
function exportBaseName(parent: Zotero.Item | null): string {
  if (!parent) return "unknown";
  let citationKey = (
    (parent.getField?.("citationKey") as string | undefined) ?? ""
  ).trim();
  if (!citationKey) {
    const extra = (parent.getField?.("extra") as string | undefined) ?? "";
    const m = extra.match(/^Citation Key:\s*(\S+)/m);
    if (m) citationKey = m[1];
  }
  // Sanitise — strip filesystem-hostile characters defensively.
  const safe = (citationKey || parent.key || "unknown").replace(
    /[\\/:*?"<>|]/g,
    "_",
  );
  return safe;
}

/**
 * Lightweight liveness check used by the "Test Connection" button in prefs.
 * Returns the resolved server URL on success so the UI can display it.
 */
/**
 * Quick "is the server up" check for batch orchestrators to call before
 * looping. Reads serverUrl from prefs and hits /health. Returns true on
 * success; on failure the caller should toast a single concise message and
 * skip the batch — avoids spamming N "Cannot reach docling-serve" toasts.
 */
export async function preflightServer(): Promise<boolean> {
  const serverUrl = (getPref("serverUrl") as string) ?? "";
  if (!serverUrl.trim()) return false;
  const r = await testServerConnection(serverUrl);
  return r.ok;
}

/**
 * Validate and normalise the configured server URL. The URL is a base that
 * every endpoint (/health, /v1/convert/file, ...) is appended to, so a path
 * is allowed — docling-serve behind a reverse proxy often lives at e.g.
 * http://host:9292/upstream/docling-serve (issue #44). A query string or
 * fragment is rejected because appending a path after it would break.
 */
/**
 * One-time cleanup for servers configured as http://user:pass@host. URL
 * credentials are now rejected (they were silently dropped before), so move
 * them into the Basic auth settings — unless another auth scheme is already
 * set up, in which case keep that and just strip the URL. Without this,
 * auto-convert for such users would only report "docling-serve isn't
 * running".
 */
export function migrateUrlCredentials(): void {
  const raw = ((getPref("serverUrl") as string) ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return;
  }
  if (!parsed.username && !parsed.password) return;
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  parsed.username = "";
  parsed.password = "";
  const scheme = ((getPref("authScheme") as string) ?? "none").toLowerCase();
  if (scheme === "none" || scheme === "") {
    setPref("authScheme", "basic");
    setPref("authUsername", user);
    setPref("authSecret", pass);
  }
  setPref("serverUrl", parsed.toString().replace(/\/+$/, ""));
  log("moved credentials out of the server URL");
}

export function normalizeServerUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, message: "Server URL is empty" };
  // Validate before issuing a fetch — a missing scheme produces confusing
  // low-level errors otherwise.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: `Invalid URL — missing scheme? Try http://${trimmed}`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // "localhost:5001" parses with scheme "localhost:" — that's a missing
    // scheme, not an exotic one.
    if (!trimmed.includes("://")) {
      return {
        ok: false,
        message: `Invalid URL — missing scheme? Try http://${trimmed}`,
      };
    }
    return {
      ok: false,
      message: `Unsupported scheme "${parsed.protocol}" — use http or https`,
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message:
        "Server URL must not include a username or password — enter them under Authentication instead",
    };
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      message: "Server URL must not include a query string or #fragment",
    };
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${parsed.origin}${basePath}` };
}

export async function testServerConnection(
  serverUrl: string,
): Promise<{ ok: true; serverUrl: string } | { ok: false; message: string }> {
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized.ok) return normalized;
  const url = normalized.url;
  let api: ReturnType<typeof getWebApis>;
  try {
    api = getWebApis();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  try {
    return await withRequestTimeout(
      timeoutMs("healthTimeoutSec", 30),
      async (signal) => {
        const r = await api.fetch(`${url}/health`, {
          method: "GET",
          headers: buildAuthHeader(),
          signal,
        });
        if (!r.ok) return { ok: false as const, message: `HTTP ${r.status}` };
        const body = await r.json().catch(() => ({}) as { status?: string });
        if ((body as { status?: string }).status === "ok") {
          return { ok: true as const, serverUrl: url };
        }
        return {
          ok: false as const,
          message: `Unexpected /health body: ${JSON.stringify(body)}`,
        };
      },
      api.AbortController,
    );
  } catch (e) {
    if (e instanceof RequestTimeoutError) {
      return {
        ok: false,
        message: `${e.message} waiting for /health (Settings → Advanced → Timeouts → Connection check)`,
      };
    }
    return { ok: false, message: (e as Error).message };
  }
}
