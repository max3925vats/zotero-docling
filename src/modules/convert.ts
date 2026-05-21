// Core conversion flow: read PDF → POST to docling-serve → attach .md back.
//
// All docling-serve options live in plugin prefs (see addon/prefs.js). They are
// flattened into individual multipart form fields here; there is NO `options`
// JSON blob — the server schema is flat.
//
// Verified against docling-serve 1.18.0 on 2026-05.

import { getPref } from "../utils/prefs";
import {
  hasMarkdownChild,
  getLocalFilePath,
  isConvertiblePdf,
} from "../utils/zotero";
import { buildFrontmatter } from "../utils/frontmatter";
import { withDbLock } from "../utils/dbLock";

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
 * Z9's plugin sandbox exposes some Web APIs as bare globals (e.g. fetch) but
 * not others (e.g. FormData, Blob). Prefer bare globals when present, fall
 * back to a window context when not.
 */
export function getWebApis(): {
  FormData: typeof FormData;
  Blob: typeof Blob;
  fetch: typeof fetch;
} {
  const g = globalThis as any;
  const win =
    (Zotero as any).getMainWindow?.() ??
    (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;

  const FormDataCtor = g.FormData ?? win?.FormData;
  const BlobCtor = g.Blob ?? win?.Blob;
  const fetchFn = g.fetch ?? (win?.fetch ? win.fetch.bind(win) : undefined);

  if (!FormDataCtor || !BlobCtor || !fetchFn) {
    throw new Error(
      `Web API unavailable — FormData=${!!FormDataCtor} Blob=${!!BlobCtor} fetch=${!!fetchFn}`,
    );
  }
  return { FormData: FormDataCtor, Blob: BlobCtor, fetch: fetchFn };
}

export type ConvertResult =
  | { status: "ok"; attachmentID: number }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string };

/**
 * Tracks PDF attachment IDs that have a conversion currently in flight,
 * across all orchestrators (menu + notifier). If a second convert call
 * lands for the same item while the first is still running we skip the
 * duplicate — otherwise docling-serve happily processes both and we end
 * up with two .md siblings.
 */
const inFlightItems = new Set<number>();

/** docling-serve response envelope (subset we read). */
interface ConvertResponse {
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
 */
function buildConvertForm(
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
  const vlmPreset = (getPref("vlmPreset") ?? "default") as string;
  if (vlmPreset) form.append("vlm_pipeline_preset", vlmPreset);

  const doPicDesc = (getPref("doPictureDescription") ?? false) as boolean;
  form.append("do_picture_description", String(doPicDesc));
  if (doPicDesc) {
    const picPreset = (getPref("pictureDescriptionPreset") ??
      "default") as string;
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

  for (const [parentID, s] of perParent) {
    if (s.ok === 0 && s.error === 0) continue; // all-skipped — leave existing tag
    const tag =
      s.error === 0 ? TAG_DONE : s.ok === 0 ? TAG_ERROR : TAG_INCOMPLETE;
    try {
      const parent = Zotero.Items.get(parentID);
      if (!parent) continue;
      await withDbLock(async () => {
        for (const t of ALL_STATUS_TAGS) parent.removeTag(t);
        parent.addTag(tag, 0);
        await parent.saveTx();
      });
    } catch (e) {
      Zotero.debug(
        `${LOG} applyStatusTags parent=${parentID} failed (non-fatal): ${(e as Error).message}`,
      );
    }
  }
}

/** Concise "errors[]" rendering for surfacing in toasts and logs. */
function formatServerErrors(data: ConvertResponse): string {
  const parts = (data.errors ?? [])
    .map((e) => e?.error_message ?? JSON.stringify(e))
    .filter(Boolean);
  return parts.join(" | ") || `status="${data.status ?? "unknown"}"`;
}

// ---------------------------------------------------------------------------
//  Talk to docling-serve — sync or async transport
// ---------------------------------------------------------------------------

type FetchOutcome =
  | { ok: true; data: ConvertResponse }
  | { ok: false; message: string };

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
    return { ok: false, message: hasDetail ? `${label}: ${errs}` : label };
  }
  return { ok: true, data };
}

/** Sync transport: POST + immediate response. */
async function fetchConvertResultSync(
  serverUrl: string,
  form: FormData,
  api: ReturnType<typeof getWebApis>,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await api.fetch(`${serverUrl}/v1/convert/file`, {
      method: "POST",
      body: form,
    });
  } catch (e) {
    Zotero.debug(`${LOG} sync fetch failed: ${(e as Error).message}`);
    return { ok: false, message: "Server not reachable" };
  }
  return parseConvertResponse(response);
}

/** Plain sleep — no abort plumbing (see file header note on cancel). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Async transport: submit job → poll status → fetch result.
 * Avoids upstream proxy/gateway timeouts on long VLM conversions.
 */
async function fetchConvertResultAsync(
  serverUrl: string,
  form: FormData,
  api: ReturnType<typeof getWebApis>,
): Promise<FetchOutcome> {
  const pollSec = Math.max(
    1,
    Number(getPref("asyncPollIntervalSec") ?? 5) || 5,
  );

  // 1. Submit
  let submitResp: Response;
  try {
    submitResp = await api.fetch(`${serverUrl}/v1/convert/file/async`, {
      method: "POST",
      body: form,
    });
  } catch (e) {
    Zotero.debug(`${LOG} async submit failed: ${(e as Error).message}`);
    return { ok: false, message: "Server not reachable" };
  }
  if (!submitResp.ok) {
    return { ok: false, message: `Submit ${httpLabelOf(submitResp)}` };
  }
  const submitBody = (await submitResp
    .json()
    .catch(() => ({}))) as TaskStatusResponse;
  const taskId = submitBody.task_id;
  if (!taskId) {
    return { ok: false, message: "Async submit returned no task_id" };
  }
  log(`async task submitted id=${taskId}`);

  // 2. Poll until terminal. No client-side timeout — docling-serve has no
  // per-task cancel API, so giving up here would just abandon a server task
  // that keeps running invisibly. See README "Known limitations".
  while (true) {
    await sleep(pollSec * 1000);

    let pollResp: Response;
    try {
      pollResp = await api.fetch(`${serverUrl}/v1/status/poll/${taskId}`);
    } catch (e) {
      Zotero.debug(`${LOG} async poll failed: ${(e as Error).message}`);
      // Transient network blip — keep polling until maxWait expires.
      continue;
    }
    if (!pollResp.ok) {
      return { ok: false, message: `Poll ${httpLabelOf(pollResp)}` };
    }
    const status = (await pollResp
      .json()
      .catch(() => ({}))) as TaskStatusResponse;
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
    // pending / started / undefined → keep polling
  }

  // 3. Fetch result
  let resultResp: Response;
  try {
    resultResp = await api.fetch(`${serverUrl}/v1/result/${taskId}`);
  } catch (e) {
    Zotero.debug(`${LOG} async result fetch failed: ${(e as Error).message}`);
    return { ok: false, message: "Server not reachable while fetching result" };
  }
  return parseConvertResponse(resultResp);
}

/** Dispatch to sync or async transport based on the useAsyncEndpoint pref. */
async function fetchConvertResult(
  serverUrl: string,
  form: FormData,
  api: ReturnType<typeof getWebApis>,
): Promise<FetchOutcome> {
  const useAsync = (getPref("useAsyncEndpoint") ?? false) as boolean;
  log(`transport=${useAsync ? "async" : "sync"}`);
  return useAsync
    ? fetchConvertResultAsync(serverUrl, form, api)
    : fetchConvertResultSync(serverUrl, form, api);
}

/**
 * Convert a single PDF attachment item.
 * Caller is responsible for any UI feedback AND for applying status tags
 * (call `applyStatusTagsToParents` after a batch) — this function only
 * returns the per-attachment result.
 */
export async function convertAttachment(
  item: Zotero.Item,
  options?: { force?: boolean },
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

async function convertAttachmentInner(
  item: Zotero.Item,
  options?: { force?: boolean },
): Promise<ConvertResult> {
  const force = options?.force ?? false;

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

  // --- 4. Read bytes ---
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await IOUtils.read(pdfPath);
  } catch (e) {
    return {
      status: "error",
      message: `Failed to read PDF: ${(e as Error).message}`,
    };
  }

  // --- 5. Build form + POST ---
  const serverUrl = ((getPref("serverUrl") as string) ?? "")
    .replace(/\/+$/, "")
    .trim();
  if (!serverUrl) {
    return { status: "error", message: "serverUrl preference is empty" };
  }

  let api: ReturnType<typeof getWebApis>;
  try {
    api = getWebApis();
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }

  let form: FormData;
  try {
    form = buildConvertForm(pdfBytes, filename, api);
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }

  // --- 6. Talk to docling-serve via sync or async transport ---
  log(`send ${serverUrl} file=${filename}`);
  const outcome = await fetchConvertResult(serverUrl, form, api);
  if (!outcome.ok) {
    return { status: "error", message: outcome.message };
  }
  const data = outcome.data;

  const okStatus =
    data.status === "success" || data.status === "partial_success";
  if (!okStatus) {
    return {
      status: "error",
      message: `Conversion ${data.status ?? "unknown"}: ${formatServerErrors(data)}`,
    };
  }
  const rawMarkdown = data.document?.md_content;
  if (typeof rawMarkdown !== "string" || rawMarkdown.length === 0) {
    return { status: "error", message: "Server returned empty md_content" };
  }

  // --- 7. Optionally prepend YAML frontmatter built from parent's metadata ---
  const addFrontmatter = (getPref("addFrontmatter") ?? true) as boolean;
  const parentItem = Zotero.Items.get(parentItemID);
  const fm = addFrontmatter ? buildFrontmatter(parentItem ?? null) : "";
  const markdown = fm ? `${fm}\n${rawMarkdown}` : rawMarkdown;

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
  const mdName = filename.replace(/\.pdf$/i, ".md");
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
  }

  // --- 11. Export to filesystem folder (if configured) ---
  // Naming: citationKey when set on the parent (BBT), else parent's Zotero key.
  // Two PDFs under one parent will produce the same export filename — last
  // write wins. Documented in the README.
  if (exportFolder) {
    try {
      await IOUtils.makeDirectory(exportFolder, { ignoreExisting: true });
      const exportName = `${exportBaseName(parentItem)}.md`;
      const exportPath = PathUtils.join(exportFolder, exportName);
      await IOUtils.writeUTF8(exportPath, markdown);
      log(`exported ${exportPath}`);
    } catch (e) {
      // Don't fail the whole conversion if export fails — the Zotero
      // attachment (if requested) already landed.
      Zotero.debug(
        `${LOG} export to folder failed (non-fatal): ${(e as Error).message}`,
      );
    }
  }

  // --- 12. Best-effort cleanup of the per-item temp subdir ---
  await IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});

  Zotero.debug(
    `${LOG} ok item=${item.key} md=${markdown.length}b in ${data.processing_time ?? "?"}s`,
  );
  return { status: "ok", attachmentID: attachmentID ?? -1 };
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
  const serverUrl = ((getPref("serverUrl") as string) ?? "")
    .replace(/\/+$/, "")
    .trim();
  if (!serverUrl) return false;
  const r = await testServerConnection(serverUrl);
  return r.ok;
}

export async function testServerConnection(
  serverUrl: string,
): Promise<{ ok: true; serverUrl: string } | { ok: false; message: string }> {
  const url = serverUrl.replace(/\/+$/, "").trim();
  if (!url) return { ok: false, message: "Server URL is empty" };
  let api: ReturnType<typeof getWebApis>;
  try {
    api = getWebApis();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  try {
    const r = await api.fetch(`${url}/health`, { method: "GET" });
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}) as { status?: string });
    if ((body as { status?: string }).status === "ok") {
      return { ok: true, serverUrl: url };
    }
    return {
      ok: false,
      message: `Unexpected /health body: ${JSON.stringify(body)}`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
