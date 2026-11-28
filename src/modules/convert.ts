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
import {
  enrichRemotePicError,
  enrichServerError,
} from "../utils/serverErrorHints";
import { buildAuthHeader } from "./credentials";
import { fetchConvertResult, timeoutMs } from "./transport";
import { RequestTimeoutError, withRequestTimeout } from "../utils/timeout";
import {
  getSecret,
  providerKeyName,
  secretsReady,
  secretWritesSettled,
} from "../utils/secrets";
import {
  buildRemotePicField,
  readRemoteSettings,
  remotePicEnabled,
  resolveRemoteMode,
  validateRemoteSettings,
  type RemotePicField,
} from "./remotePictureApi";

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
 * Make sure the secrets cache is loaded and holds the latest edits. A broken
 * login manager must not stop conversions: log it and carry on without the
 * stored secrets (the legacy authSecret pref still works as a fallback).
 */
async function settleSecrets(): Promise<void> {
  await secretsReady().catch((e: unknown) =>
    log(`couldn't read saved credentials: ${(e as Error).message}`),
  );
  await secretWritesSettled();
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

export type WebApis = ReturnType<typeof getWebApis>;

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

/** docling-serve response envelope (subset we read). */
export interface ConvertResponse {
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
  remote?: RemotePicField,
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

  // A remote vision API (#17) replaces the local preset: docling-serve calls
  // the provider itself, so description must be on and no preset is sent.
  const doPicDesc =
    !!remote || ((getPref("doPictureDescription") ?? false) as boolean);
  form.append("do_picture_description", String(doPicDesc));
  if (remote) {
    form.append(remote.name, remote.value);
  } else if (doPicDesc) {
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
    // The two remote fields are mutually exclusive on the server; if Advanced
    // JSON sets either, drop whatever the UI built for both.
    if (
      "picture_description_api" in parsed ||
      "picture_description_custom_config" in parsed
    ) {
      form.delete("picture_description_api");
      form.delete("picture_description_custom_config");
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

/**
 * True when Advanced JSON sets either remote picture-description field. An
 * unparsable value counts as "not set": buildConvertForm reports that error.
 */
function advancedJsonSetsRemotePic(): boolean {
  const raw = String(getPref("advancedJson") ?? "").trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      ("picture_description_api" in parsed ||
        "picture_description_custom_config" in parsed)
    );
  } catch {
    // Invalid JSON is reported by buildConvertForm; don't report it twice.
    return false;
  }
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
export function formatServerErrors(data: ConvertResponse): string {
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
  // The auth secret lives in the login manager; make sure it is loaded.
  await settleSecrets();
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

  // Re-convert: remember the current .md now, but leave it in place until the
  // replacement is attached — a failed conversion must not cost the user
  // their existing markdown (audit H3).
  const previousMd = force ? findMatchingMdChild(parentItemID, filename) : null;

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
  const normalizedUrl = normalizeServerUrl(
    (getPref("serverUrl") as string) ?? "",
  );
  if (!normalizedUrl.ok) {
    return { status: "error", message: normalizedUrl.message };
  }
  const serverUrl = normalizedUrl.url;

  let api: WebApis;
  try {
    api = getWebApis();
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }

  let remote: RemotePicField | undefined;
  const settings = remotePicEnabled() ? readRemoteSettings() : null;
  if (settings) {
    // Each provider has its own key slot, so switching provider never sends
    // the previous provider's key.
    const key = getSecret(providerKeyName(settings.provider));
    // Advanced JSON that supplies the field itself overrides what we'd build,
    // so incomplete UI settings mustn't block the conversion.
    const invalid = advancedJsonSetsRemotePic()
      ? null
      : validateRemoteSettings(settings, key);
    if (invalid) return { status: "error", message: invalid };
    const mode = await resolveRemoteMode(serverUrl, api);
    log(`remote picture API mode=${mode} provider=${settings.provider}`);
    remote = buildRemotePicField(mode, settings, key);
  }

  let form: FormData;
  try {
    form = buildConvertForm(pdfBytes, filename, api, remote);
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }

  // --- 6. Talk to docling-serve via sync or async transport ---
  log(`send ${serverUrl} file=${filename}`);
  const outcome = await fetchConvertResult(serverUrl, form, api);
  // Hint context: only add remote-API causes when the feature actually ran.
  const hintCtx = {
    enabled: !!remote,
    providerUrl: remote && settings ? settings.url : "",
  };
  if (!outcome.ok) {
    return {
      status: "error",
      message: enrichRemotePicError(outcome.message, hintCtx),
    };
  }
  const data = outcome.data;

  const okStatus =
    data.status === "success" || data.status === "partial_success";
  if (!okStatus) {
    const raw = `Conversion ${data.status ?? "unknown"}: ${formatServerErrors(data)}`;
    return {
      status: "error",
      message: enrichRemotePicError(enrichServerError(raw), hintCtx),
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
  let exportWarning: string | undefined;
  if (exportFolder) {
    try {
      await IOUtils.makeDirectory(exportFolder, { ignoreExisting: true });
      const exportName = `${exportBaseName(parentItem)}.md`;
      const exportPath = PathUtils.join(exportFolder, exportName);
      await IOUtils.writeUTF8(exportPath, markdown);
      log(`exported ${exportPath}`);
    } catch (e) {
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
  await settleSecrets();
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized.ok) return normalized;
  const url = normalized.url;
  let api: WebApis;
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
