// Wires up dynamic behavior in the preferences pane:
//   - "Test Connection" button → hits docling-serve /health and shows result
//   - Pipeline radio change → show/hide VLM section
//   - Preset dropdowns "Custom…" entry → reveal a free-text input
//   - "Reset to defaults" button → confirm + clear every plugin pref

import { getLocaleID } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { clearAllSecrets } from "../utils/secrets";
import { FluentMessageId } from "../../typings/i10n";
import { testServerConnection } from "./convert";
import { bindSecretField } from "./remotePicPane";
import { clearCapabilitiesCache } from "./remotePictureApi";

const LOG = "[zotero-docling]";

/**
 * The full list of plugin prefs. Kept in sync with addon/prefs.js so that
 * Reset-to-defaults knows what to clear. Each Zotero.Prefs.clear() reverts
 * the corresponding pref to whatever prefs.js declared at install time.
 */
export const ALL_PREF_KEYS: ReadonlyArray<string> = [
  "serverUrl",
  "autoConvert",
  "skipIfExists",
  "authScheme",
  "authUsername",
  "authSecret",
  "authHeaderName",
  "pipeline",
  "doOcr",
  "forceOcr",
  "tableMode",
  "excludeImages",
  "doFormulaEnrichment",
  "doCodeEnrichment",
  "doChartExtraction",
  "doPictureClassification",
  "vlmPreset",
  "doPictureDescription",
  "pictureDescriptionPreset",
  "ocrLang",
  "advancedJson",
  "useAsyncEndpoint",
  "asyncPollIntervalSec",
  "asyncMaxWaitMin",
  "vlmPresetCustom",
  "pictureDescriptionPresetCustom",
  "remotePicApiEnabled",
  "remotePicApiProvider",
  "remotePicApiUrl",
  "remotePicApiModel",
  "remotePicApiPrompt",
  "remotePicApiTimeoutSec",
  "healthTimeoutSec",
  "pollTimeoutSec",
  "asyncUploadTimeoutMin",
  "asyncResultTimeoutMin",
  "syncTimeoutMin",
  "maxConcurrency",
  "addFrontmatter",
  "attachToItem",
  "exportFolderPath",
  "notifyOnComplete",
  "prefsLayerConversionExpanded",
  "prefsLayerAdvancedExpanded",
  "confirmReconvert",
  "firstRunCompleted",
  "lastHealthResult",
];

/**
 * Hover-summary text for VLM presets, used both as menuitem tooltiptext
 * (set in the XHTML) and as the live description below the dropdown.
 * Keep these in sync with the XHTML if either changes — duplication is
 * cheaper than wiring a shared source for fifteen short strings.
 */
const VLM_PRESET_DETAIL: Record<string, string> = {
  default:
    "docling-serve's built-in default — Granite-Docling (~500 MB). Recommended starting point.",
  smoldocling:
    "HuggingFaceTB/SmolDocling — smallest, fastest. ~256 MB. Good on low-RAM machines.",
  deepseek_ocr: "DeepSeek-OCR — strong on dense academic text. ~3 GB.",
  granite_vision:
    "IBM Granite Vision — general-purpose, ~500 MB. Same family as the default.",
  pixtral: "Mistral Pixtral — large, multi-GB. Strong figure understanding.",
  got_ocr: "GOT-OCR2 — general OCR, good on scanned material.",
  phi4: "Microsoft Phi-4 multimodal — mid-size, strong reasoning.",
  qwen: "Qwen2-VL — Alibaba, broad-domain VLM. Multi-GB.",
  nanonets_ocr2: "Nanonets-OCR-s — purpose-built for document OCR.",
  gemma_12b: "Google Gemma 3 12B — very capable, ~24 GB RAM/GPU recommended.",
  gemma_27b: "Google Gemma 3 27B — top quality, 40+ GB RAM/GPU needed.",
  dolphin: "Dolphin — VLM tuned for academic/STEM figures.",
  glm_ocr: "GLM-4V OCR — Zhipu AI, multi-GB.",
  lightonocr: "LightOnOCR — efficient OCR-focused VLM.",
  falcon_ocr: "Falcon OCR — TII multilingual OCR.",
};

const PIC_PRESET_DETAIL: Record<string, string> = {
  default:
    "docling-serve's built-in default. Small, fast, sensible starting point.",
  smolvlm: "SmolVLM — smallest local picture-description model. ~500 MB.",
  granite_vision: "IBM Granite Vision — better descriptions, ~500 MB.",
};

/**
 * Fluent ID for the auth secret label, by scheme. Returned with the build's
 * addonRef prefix: a bare ID set at runtime doesn't resolve, which left the
 * label blank (audit H4).
 */
export function authSecretLabelId(scheme: string): string {
  if (scheme === "bearer") return getLocaleID("pref-auth-token");
  if (scheme === "basic") return getLocaleID("pref-auth-password");
  if (scheme === "custom") return getLocaleID("pref-auth-header-value");
  return getLocaleID("pref-auth-secret");
}

/**
 * Older versions stored a typed custom preset name directly in the menu's
 * pref, which the menu can't display. Returns the split to apply
 * (menu → "Custom…", name → custom field), or null if `value` is a known
 * menu entry and nothing needs migrating.
 */
export function migrateLegacyCustomPreset(
  value: string,
  known: string[],
): { preset: string; custom: string } | null {
  if (!value || known.includes(value)) return null;
  return { preset: "__custom__", custom: value };
}

export function registerPrefsScripts(win: Window): void {
  // Keep a handle to the prefs window in addon.data — the template's addon.ts
  // already declares the slot.
  addon.data.prefs = addon.data.prefs ?? { window: win, columns: [], rows: [] };
  addon.data.prefs.window = win;

  bindTestConnection(win);
  // Each binder returns the function that re-syncs its piece of the pane
  // from prefs; Reset re-runs them all after clearing (audit M12).
  const refreshers: Array<() => void> = [];
  const keep = (r: (() => void) | void) => {
    if (r) refreshers.push(r);
  };
  keep(bindPipelineToggle(win));
  keep(bindPresetCustomToggle(win, "vlm"));
  keep(bindPresetCustomToggle(win, "pic"));
  keep(bindAuthSchemeToggle(win));
  keep(
    bindSecretField(win, "zotero-docling-auth-secret", "docling-serve-auth"),
  );
  keep(bindPresetDetail(win, "vlm", VLM_PRESET_DETAIL, "vlmPreset"));
  keep(
    bindPresetDetail(win, "pic", PIC_PRESET_DETAIL, "pictureDescriptionPreset"),
  );
  keep(
    bindDisclosure(
      win,
      "zotero-docling-disclosure-conversion",
      "zotero-docling-conversion-section",
      "prefsLayerConversionExpanded",
      "pref-disclosure-conversion-collapsed",
      "pref-disclosure-conversion-expanded",
    ),
  );
  keep(
    bindDisclosure(
      win,
      "zotero-docling-disclosure-advanced",
      "zotero-docling-advanced-section",
      "prefsLayerAdvancedExpanded",
      "pref-disclosure-advanced-collapsed",
      "pref-disclosure-advanced-expanded",
    ),
  );
  bindResetButton(win, refreshers);
}

/**
 * Disclosure button → toggle visibility of the wrapped section and persist
 * the open state in a preference. Persistence is per-session-and-restart
 * because Zotero.Prefs survives across both; the issue called for
 * per-session and per-restart is a free bonus.
 */
function bindDisclosure(
  win: Window,
  buttonId: string,
  sectionId: string,
  prefKey: "prefsLayerConversionExpanded" | "prefsLayerAdvancedExpanded",
  collapsedL10nId: FluentMessageId,
  expandedL10nId: FluentMessageId,
): (() => void) | void {
  const btn = win.document.getElementById(buttonId) as HTMLElement | null;
  const section = win.document.getElementById(sectionId) as HTMLElement | null;
  if (!btn || !section) return;

  const refresh = (expanded: boolean) => {
    section.hidden = !expanded;
    // getLocaleID adds the addonRef prefix the build applies to every FTL
    // message; a bare ID would not resolve and the heading would go blank.
    btn.setAttribute(
      "data-l10n-id",
      getLocaleID(expanded ? expandedL10nId : collapsedL10nId),
    );
  };

  const initial = (getPref(prefKey) ?? false) as boolean;
  refresh(initial);

  btn.addEventListener("click", () => {
    // Currently hidden → expand. `as boolean` because section.hidden's
    // inferred type drags in null through the HTMLElement.hidden setter
    // overload that accepts string | boolean | null.
    const next = section.hidden as boolean;
    refresh(next);
    try {
      if (prefKey === "prefsLayerConversionExpanded") {
        setPref("prefsLayerConversionExpanded", next);
      } else {
        setPref("prefsLayerAdvancedExpanded", next);
      }
    } catch {
      /* persistence is nice-to-have */
    }
  });
  return () => refresh((getPref(prefKey) ?? false) as boolean);
}

/**
 * Inline preset description below a dropdown — updates as the user
 * cycles through options. Reads the current pref value on first paint
 * so the row matches what's already saved.
 */
function bindPresetDetail(
  win: Window,
  kind: "vlm" | "pic",
  detailMap: Record<string, string>,
  prefKey: "vlmPreset" | "pictureDescriptionPreset",
): (() => void) | void {
  const menu = win.document.getElementById(
    `zotero-docling-${kind}-preset-menu`,
  ) as (HTMLElement & { value?: string }) | null;
  const custom = win.document.getElementById(
    `zotero-docling-${kind}-preset-custom`,
  ) as (HTMLElement & { value?: string }) | null;
  const detail = win.document.getElementById(
    `zotero-docling-${kind}-preset-detail`,
  ) as HTMLElement | null;
  if (!menu || !detail) return;
  const customKey =
    prefKey === "vlmPreset"
      ? "vlmPresetCustom"
      : "pictureDescriptionPresetCustom";

  const apply = (value: string, customName: string) => {
    const name = value === "__custom__" ? customName.trim() : value;
    detail.textContent =
      detailMap[name] ??
      (name
        ? `Custom preset "${name}" — described by your docling-serve build.`
        : value === "__custom__"
          ? "Type a preset name your docling-serve build supports. Empty uses the server's default."
          : "");
  };
  // Live: read the elements (prefs may lag a pick or a keystroke).
  const fromElements = () =>
    apply((menu.value as string) ?? "", (custom?.value as string) ?? "");
  menu.addEventListener("command", fromElements);
  custom?.addEventListener("input", fromElements);
  // Re-sync (load, Reset): read the prefs.
  const fromPref = () =>
    apply(
      ((getPref(prefKey) as string) ?? "").trim(),
      (getPref(customKey) as string) ?? "",
    );
  fromPref();
  return fromPref;
}

/**
 * Authentication scheme menu → show/hide the relevant credential rows.
 *
 *   none    → no credential rows
 *   bearer  → secret row (labelled "Token")
 *   basic   → username row + secret row (labelled "Password")
 *   custom  → header-name row + secret row (labelled "Header value")
 *
 * Same labels for "secret" and "username" rows are reused across schemes
 * and rewritten dynamically — saves declaring four separate input widgets
 * bound to four prefs that all mean roughly the same thing.
 */
function bindAuthSchemeToggle(win: Window): (() => void) | void {
  const menu = win.document.getElementById("zotero-docling-auth-scheme") as
    (HTMLElement & { value?: string }) | null;
  const usernameRow = win.document.getElementById(
    "zotero-docling-auth-username-row",
  ) as HTMLElement | null;
  const headerNameRow = win.document.getElementById(
    "zotero-docling-auth-header-name-row",
  ) as HTMLElement | null;
  const secretRow = win.document.getElementById(
    "zotero-docling-auth-secret-row",
  ) as HTMLElement | null;
  const secretLabel = win.document.getElementById(
    "zotero-docling-auth-secret-label",
  ) as HTMLElement | null;
  const help = win.document.getElementById(
    "zotero-docling-auth-help",
  ) as HTMLElement | null;
  if (!menu || !usernameRow || !headerNameRow || !secretRow) return;

  const apply = (value: string | undefined) => {
    const scheme = (value || "none").toLowerCase();
    const showSecret = scheme !== "none";
    usernameRow.hidden = scheme !== "basic";
    headerNameRow.hidden = scheme !== "custom";
    secretRow.hidden = !showSecret;
    if (help) help.hidden = !showSecret;
    // Relabel the secret input so the field name matches the chosen scheme.
    if (secretLabel) {
      secretLabel.setAttribute("data-l10n-id", authSecretLabelId(scheme));
    }
  };
  // On a menu pick, read the menu itself (its pref may not be written yet);
  // when re-syncing (load, Reset), read the pref — the source of truth.
  menu.addEventListener("command", () => apply(menu.value as string));
  const fromPref = () => apply(getPref("authScheme") as string);
  fromPref();
  return fromPref;
}

/**
 * Render the saved health result into the status label without firing a
 * new request. Used on prefs-pane open so a returning user sees the last
 * known state instead of an empty line.
 */
function paintHealthLabel(
  label: HTMLElement,
  result: { ok: boolean; message?: string; serverUrl?: string; at?: string },
): void {
  const stamp = result.at
    ? ` (last checked ${result.at.slice(0, 16).replace("T", " ")})`
    : "";
  if (result.ok) {
    label.textContent = `Connected ✓  (${result.serverUrl ?? ""})${stamp}`;
    label.style.color = "var(--accent-green, #2a8000)";
  } else {
    label.textContent = `Cannot connect — ${result.message ?? "unknown"}${stamp}`;
    label.style.color = "var(--accent-red, #c00)";
  }
}

/** "Test Connection" button → calls /health, paints status label + persists. */
function bindTestConnection(win: Window): void {
  const btn = win.document.getElementById(
    "zotero-docling-test-connection",
  ) as HTMLElement | null;
  const label = win.document.getElementById(
    "zotero-docling-test-result",
  ) as HTMLElement | null;
  if (!btn || !label) {
    Zotero.debug(`${LOG} prefs: test-connection elements not found`);
    return;
  }

  const runCheck = async (): Promise<void> => {
    const serverUrl =
      ((getPref("serverUrl") as string) ?? "").trim() ||
      "http://localhost:5001";
    label.textContent = "Testing…";
    label.style.color = "";
    // Re-probe /v1/capabilities: the user may have just restarted the server.
    clearCapabilitiesCache();
    const result = await testServerConnection(serverUrl);
    const snapshot = {
      ok: result.ok,
      message: result.ok ? "" : result.message,
      serverUrl: result.ok ? result.serverUrl : serverUrl,
      at: new Date().toISOString(),
    };
    paintHealthLabel(label, snapshot);
    try {
      setPref("lastHealthResult", JSON.stringify(snapshot));
    } catch {
      /* persistence is nice-to-have */
    }
    if (result.ok) {
      // First successful connection completes the onboarding nudge so the
      // startup toast doesn't keep firing.
      try {
        setPref("firstRunCompleted", true);
      } catch {
        /* ignore */
      }
    }
  };

  btn.addEventListener("command", () => {
    void runCheck();
  });

  // Auto-run on first prefs-pane open in this session when there's no saved
  // result; otherwise paint the saved one so the user has immediate signal.
  const saved = ((getPref("lastHealthResult") as string) ?? "").trim();
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as {
        ok: boolean;
        message?: string;
        serverUrl?: string;
        at?: string;
      };
      paintHealthLabel(label, parsed);
    } catch {
      void runCheck();
    }
  } else {
    void runCheck();
  }
}

/** Pipeline radiogroup → show/hide the VLM section. */
function bindPipelineToggle(win: Window): (() => void) | void {
  const group = win.document.getElementById(
    "zotero-docling-pipeline-group",
  ) as HTMLElement | null;
  const vlmSection = win.document.getElementById(
    "zotero-docling-vlm-section",
  ) as HTMLElement | null;
  if (!vlmSection) return;

  const apply = (pipeline: string | undefined) => {
    vlmSection.hidden = (pipeline ?? "standard") !== "vlm";
  };
  // On a pick, read the radiogroup (its pref may not be written yet, which
  // left the VLM section one click behind); on re-sync, read the pref.
  if (group) {
    group.addEventListener("command", () =>
      apply((group as HTMLElement & { value?: string }).value),
    );
  }
  const fromPref = () => apply(getPref("pipeline") as string);
  fromPref();
  return fromPref;
}

/**
 * "Reset to defaults" button → confirm dialog → clear every plugin pref.
 * Uses the Services.prompt cross-platform confirm dialog; user must opt-in.
 */
function bindResetButton(win: Window, refreshers: Array<() => void>): void {
  const btn = win.document.getElementById(
    "zotero-docling-reset",
  ) as HTMLElement | null;
  if (!btn) {
    Zotero.debug(`${LOG} prefs: reset button not found`);
    return;
  }
  btn.addEventListener("command", async () => {
    // One reset at a time: a double-click during the awaits below would
    // otherwise open two prompts.
    if (btn.hasAttribute("disabled")) return;
    btn.setAttribute("disabled", "true");
    try {
      await resetPrefs(win, refreshers);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

async function resetPrefs(
  win: Window,
  refreshers: Array<() => void>,
): Promise<void> {
  const Services = (globalThis as any).Services;
  // Translated text from preferences.ftl, with English fallbacks if the
  // pane's localization isn't available.
  let [title, body, done] = [
    "Reset zotero-docling preferences?",
    "This reverts every plugin preference (Server URL, auto-convert, pipeline, VLM preset, output, etc.) to its built-in default. Your Zotero library and existing markdown attachments are not touched.",
    "Preferences reset to defaults",
  ];
  try {
    const l10n = (win.document as any).l10n;
    const values = await l10n?.formatValues?.([
      { id: getLocaleID("pref-reset-confirm-title") },
      { id: getLocaleID("pref-reset-confirm-body") },
      { id: getLocaleID("pref-reset-done") },
    ]);
    if (values?.[0]) title = values[0];
    if (values?.[1]) body = values[1];
    if (values?.[2]) done = values[2];
  } catch {
    /* keep English */
  }
  // Fail closed: no prompt service means no reset.
  if (!Services?.prompt?.confirm) {
    Zotero.debug(`${LOG} prefs: no prompt service — reset not confirmed`);
    return;
  }
  if (!Services.prompt.confirm(win, title, body)) return;

  const PREFIX = addon.data.config.prefsPrefix;
  let cleared = 0;
  for (const key of ALL_PREF_KEYS) {
    try {
      Zotero.Prefs.clear(`${PREFIX}.${key}`, true);
      cleared++;
    } catch (e) {
      Zotero.debug(
        `${LOG} prefs: clear ${key} failed: ${(e as Error).message}`,
      );
    }
  }
  Zotero.debug(`${LOG} prefs: reset ${cleared} keys to defaults`);

  // Secrets live in the login manager, not prefs, so the loop above can't
  // reach them. A failed clear is logged, not fatal: the pane still refreshes.
  try {
    await clearAllSecrets();
  } catch (e) {
    Zotero.debug(
      `${LOG} prefs: clearing secrets failed: ${(e as Error).message}`,
    );
  }

  // Bring the dynamic parts of the pane back in line with the defaults.
  for (const refresh of refreshers) {
    try {
      refresh();
    } catch {
      /* one stale section shouldn't block the rest */
    }
  }

  // ProgressWindow toast for confirmation
  try {
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("zotero-docling");
    pw.addDescription(done);
    pw.show();
    setTimeout(() => {
      try {
        pw.close();
      } catch {
        /* ignore */
      }
    }, 3000);
  } catch {
    /* ignore — toast is nice-to-have */
  }
}

/**
 * Each preset menulist has a text input next to it, bound to its own pref
 * (`vlmPresetCustom` / `pictureDescriptionPresetCustom`). Reveal it when
 * "Custom…" (`__custom__`) is selected so the user can type any preset name.
 */
function bindPresetCustomToggle(
  win: Window,
  kind: "vlm" | "pic",
): (() => void) | void {
  const menu = win.document.getElementById(
    `zotero-docling-${kind}-preset-menu`,
  ) as (HTMLElement & { value?: string }) | null;
  const custom = win.document.getElementById(
    `zotero-docling-${kind}-preset-custom`,
  ) as (HTMLElement & { value?: string }) | null;
  if (!menu || !custom) return;

  // One-time migration: older versions saved a typed name straight into the
  // menu's pref, which the menu can't show (audit M10).
  const menuKey = kind === "vlm" ? "vlmPreset" : "pictureDescriptionPreset";
  const customKey =
    kind === "vlm" ? "vlmPresetCustom" : "pictureDescriptionPresetCustom";
  const known = Array.from(menu.querySelectorAll("menuitem")).map(
    (el) => (el as Element).getAttribute("value") ?? "",
  );
  const migration = migrateLegacyCustomPreset(
    ((getPref(menuKey) as string) ?? "").trim(),
    known,
  );
  if (migration) {
    setPref(menuKey, migration.preset);
    setPref(customKey, migration.custom);
    menu.value = migration.preset;
    custom.value = migration.custom;
  }

  const apply = (value: string | undefined) => {
    custom.hidden = value !== "__custom__";
  };
  menu.addEventListener("command", () => apply(menu.value as string));
  const fromPref = () => apply(getPref(menuKey) as string);
  fromPref();
  return fromPref;
}
