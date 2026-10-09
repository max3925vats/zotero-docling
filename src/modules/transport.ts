// docling-serve transports: sync (one POST) and async (submit → poll → result).
// Moved out of convert.ts unchanged (v0.6.0) so convert.ts stays focused on
// building the request and attaching the result.

import { getPref } from "../utils/prefs";
import { enrichServerError } from "../utils/serverErrorHints";
import { RequestTimeoutError, withRequestTimeout } from "../utils/timeout";
import { toast } from "./ui";
import { buildAuthHeader } from "./credentials";
import {
  formatServerErrors,
  type ConvertResponse,
  type WebApis,
} from "./convert";

const LOG = "[zotero-docling]";

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

// ---------------------------------------------------------------------------
//  Talk to docling-serve — sync or async transport
// ---------------------------------------------------------------------------

export type FetchOutcome =
  { ok: true; data: ConvertResponse } | { ok: false; message: string };

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
export function httpLabelOf(r: Response): string {
  return r.statusText ? `HTTP ${r.status} ${r.statusText}` : `HTTP ${r.status}`;
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
export function timeoutMs(
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
  form: FormData,
  api: WebApis,
): Promise<FetchOutcome> {
  try {
    return await withRequestTimeout(
      timeoutMs("syncTimeoutMin", 10),
      async (signal) => {
        const response = await api.fetch(`${serverUrl}/v1/convert/file`, {
          method: "POST",
          body: form,
          headers: buildAuthHeader(),
          signal,
        });
        return parseConvertResponse(response);
      },
      api.AbortController,
    );
  } catch (e) {
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
  api: WebApis,
): Promise<FetchOutcome> {
  const pollSec = Math.max(
    1,
    Number(getPref("asyncPollIntervalSec") ?? 5) || 5,
  );
  // Absolute client-side wait ceiling. Does NOT cancel the server-side task
  // (no upstream cancel API; see file header). Bounded [1, 1440] minutes; the
  // pref UI also clamps these.
  const maxWaitMs = asyncMaxWaitMs(getPref("asyncMaxWaitMin"));

  // 1. Submit
  const authHeaders = buildAuthHeader();
  let submitBody: TaskStatusResponse;
  try {
    const submitted = await withRequestTimeout(
      timeoutMs("asyncUploadTimeoutMin", 5),
      async (signal) => {
        const r = await api.fetch(`${serverUrl}/v1/convert/file/async`, {
          method: "POST",
          body: form,
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
    );
    if ("label" in submitted) {
      return { ok: false, message: `Submit ${submitted.label}` };
    }
    submitBody = submitted.body;
  } catch (e) {
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
  const startedAt = Date.now();
  let consecutiveFailures = 0;
  let unresponsiveToastShown = false;
  while (true) {
    await sleep(pollSec * 1000);

    if (Date.now() - startedAt > maxWaitMs) {
      return {
        ok: false,
        message: `Async task exceeded maxWait (${maxWaitMs / 60_000} min) — server-side task may still be running`,
      };
    }

    let poll:
      { ok: false; label: string } | { ok: true; status: TaskStatusResponse };
    try {
      poll = await withRequestTimeout(
        timeoutMs("pollTimeoutSec", 30),
        async (signal) => {
          const r = await api.fetch(`${serverUrl}/v1/status/poll/${taskId}`, {
            headers: authHeaders,
            signal,
          });
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
      );
      consecutiveFailures = 0;
    } catch (e) {
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
    // pending / started / undefined → keep polling
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
    );
  } catch (e) {
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
export async function fetchConvertResult(
  serverUrl: string,
  form: FormData,
  api: WebApis,
): Promise<FetchOutcome> {
  const useAsync = (getPref("useAsyncEndpoint") ?? false) as boolean;
  log(`transport=${useAsync ? "async" : "sync"}`);
  return useAsync
    ? fetchConvertResultAsync(serverUrl, form, api)
    : fetchConvertResultSync(serverUrl, form, api);
}
