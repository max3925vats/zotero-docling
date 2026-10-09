// Remote vision APIs for picture description (#17). docling-serve, not the
// plugin, calls the provider: we only build the JSON it needs. Two fields
// exist upstream — the deprecated picture_description_api and
// picture_description_custom_config — and which one we send depends on what
// the server allows (see resolveRemoteMode). Spec:
// plan/2026-10-09-issue-17-remote-picture-api-design.md.

import { getPref } from "../utils/prefs";
import { withRequestTimeout } from "../utils/timeout";
import { buildAuthHeader } from "./credentials";
import type { WebApis } from "./convert";
import { timeoutMs } from "./transport";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "vllm"
  | "custom";

type AuthStyle = "bearer" | "optional-bearer" | "anthropic";

export const PROVIDERS: Record<
  ProviderId,
  { label: string; url: string; auth: AuthStyle; paid: boolean }
> = {
  openai: {
    label: "OpenAI",
    url: "https://api.openai.com/v1/chat/completions",
    auth: "bearer",
    paid: true,
  },
  anthropic: {
    label: "Anthropic",
    url: "https://api.anthropic.com/v1/chat/completions",
    auth: "anthropic",
    paid: true,
  },
  openrouter: {
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    auth: "bearer",
    paid: true,
  },
  ollama: {
    label: "Ollama",
    url: "http://localhost:11434/v1/chat/completions",
    auth: "optional-bearer",
    paid: false,
  },
  lmstudio: {
    label: "LM Studio",
    url: "http://localhost:1234/v1/chat/completions",
    auth: "optional-bearer",
    paid: false,
  },
  vllm: {
    label: "vLLM",
    url: "http://localhost:8000/v1/chat/completions",
    auth: "optional-bearer",
    paid: false,
  },
  custom: { label: "Custom", url: "", auth: "optional-bearer", paid: false },
};

export interface RemoteSettings {
  provider: ProviderId;
  url: string;
  model: string;
  prompt: string;
  timeoutSec: number;
}

/** custom_config's model_spec requires a prompt, so we never send an empty one. */
export const DEFAULT_PROMPT = "Describe this image in a few sentences.";

export type RemoteMode = "legacy" | "custom";

export interface RemotePicField {
  name: "picture_description_api" | "picture_description_custom_config";
  value: string;
}

export function headersFor(
  provider: ProviderId,
  key: string,
): Record<string, string> {
  const k = key.trim();
  const style = PROVIDERS[provider]?.auth ?? "optional-bearer";
  if (style === "anthropic") {
    // Anthropic's OpenAI-compatible endpoint: Bearer for the compat layer,
    // x-api-key + version for its native checks. Sending both is harmless.
    return {
      Authorization: `Bearer ${k}`,
      "x-api-key": k,
      "anthropic-version": "2023-06-01",
    };
  }
  return k ? { Authorization: `Bearer ${k}` } : {};
}

/** URL scheme with the colon, or "" when the string isn't a parseable URL. */
function protocolOf(url: string): string {
  try {
    return new URL(url.trim()).protocol;
  } catch {
    // new URL() throws on junk input; treat that as "no scheme" so the caller reports it.
    return "";
  }
}

/** Error message for unusable settings, or null if they're complete. */
export function validateRemoteSettings(
  s: RemoteSettings,
  key: string,
): string | null {
  if (!/^https?:$/.test(protocolOf(s.url))) {
    return "Remote picture API: enter a valid http(s) API URL (Settings → Conversion options)";
  }
  if (!s.model.trim()) {
    return "Remote picture API: enter a model name (Settings → Conversion options)";
  }
  if (PROVIDERS[s.provider]?.paid && !key.trim()) {
    return `Remote picture API: enter your ${PROVIDERS[s.provider].label} API key (Settings → Conversion options)`;
  }
  return null;
}

/**
 * The form field docling-serve needs. Shapes verified against docling-serve
 * 1.36.0 on 2026-10-09 with a mock OpenAI server. custom_config only works
 * with a model_spec; default_repo_id is required but meaningless for remote
 * APIs, hence the placeholder.
 */
export function buildRemotePicField(
  mode: RemoteMode,
  s: RemoteSettings,
  key: string,
): RemotePicField {
  const url = s.url.trim();
  const headers = headersFor(s.provider, key);
  const params = { model: s.model.trim() };
  const prompt = s.prompt.trim() || DEFAULT_PROMPT;
  const timeout = s.timeoutSec;
  if (mode === "legacy") {
    return {
      name: "picture_description_api",
      value: JSON.stringify({ url, headers, params, prompt, timeout }),
    };
  }
  return {
    name: "picture_description_custom_config",
    value: JSON.stringify({
      engine_options: {
        engine_type: "api_openai",
        url,
        headers,
        params,
        timeout,
      },
      model_spec: {
        name: "zotero-docling-remote",
        default_repo_id: "none/none",
        prompt,
        response_format: "markdown",
        api_overrides: {},
      },
      prompt,
    }),
  };
}

/** OpenAI-style …/chat/completions → …/models (free listing endpoint). */
export function modelsUrl(chatUrl: string): string | null {
  const trimmed = chatUrl.trim().replace(/\/+$/, "");
  if (!/\/chat\/completions$/.test(trimmed)) return null;
  return trimmed.replace(/\/chat\/completions$/, "/models");
}

export function remotePicEnabled(): boolean {
  return Boolean(getPref("remotePicApiEnabled") ?? false);
}

export function readRemoteSettings(): RemoteSettings {
  const raw = String(getPref("remotePicApiProvider") ?? "openai");
  const provider = (raw in PROVIDERS ? raw : "custom") as ProviderId;
  const t = Number(getPref("remotePicApiTimeoutSec"));
  return {
    provider,
    url: String(getPref("remotePicApiUrl") ?? ""),
    model: String(getPref("remotePicApiModel") ?? ""),
    prompt: String(getPref("remotePicApiPrompt") ?? ""),
    timeoutSec: Number.isFinite(t) && t > 0 ? t : 120,
  };
}

// The server's answer barely changes, but a user may restart docling-serve
// with a different flag mid-session — so cache briefly, not forever.
const CAPS_TTL_MS = 5 * 60_000;
const capsCache = new Map<string, { mode: RemoteMode; at: number }>();

export function clearCapabilitiesCache(): void {
  capsCache.clear();
}

/**
 * "custom" if the server accepts picture_description_custom_config (1.36+
 * reports it in /v1/capabilities when
 * DOCLING_SERVE_ALLOW_CUSTOM_PICTURE_DESCRIPTION_CONFIG=true), otherwise
 * "legacy". Any probe failure means legacy: never fail a conversion because
 * the probe did.
 */
export async function resolveRemoteMode(
  serverUrl: string,
  api: WebApis,
): Promise<RemoteMode> {
  const hit = capsCache.get(serverUrl);
  if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.mode;
  let mode: RemoteMode;
  try {
    mode = await withRequestTimeout(
      timeoutMs("healthTimeoutSec", 30),
      async (signal) => {
        const r = await api.fetch(`${serverUrl}/v1/capabilities`, {
          headers: buildAuthHeader(),
          signal,
        });
        if (!r.ok) return "legacy" as const;
        const body = JSON.parse(await r.text());
        return body?.stages?.picture_description?.custom_config_option ===
          "picture_description_custom_config"
          ? ("custom" as const)
          : ("legacy" as const);
      },
      api.AbortController,
    );
  } catch {
    mode = "legacy";
  }
  capsCache.set(serverUrl, { mode, at: Date.now() });
  return mode;
}
