// Wires up dynamic behavior in the preferences pane:
//   - "Test Connection" button → hits docling-serve /health and shows result
//   - Pipeline radio change → show/hide VLM section
//   - Preset dropdowns "Custom…" entry → reveal a free-text input
//   - "Reset to defaults" button → confirm + clear every plugin pref

import { getPref } from "../utils/prefs";
import { testServerConnection } from "./convert";

const LOG = "[zotero-docling]";

/**
 * The full list of plugin prefs. Kept in sync with addon/prefs.js so that
 * Reset-to-defaults knows what to clear. Each Zotero.Prefs.clear() reverts
 * the corresponding pref to whatever prefs.js declared at install time.
 */
const ALL_PREF_KEYS: ReadonlyArray<string> = [
  "serverUrl",
  "autoConvert",
  "skipIfExists",
  "pipeline",
  "doOcr",
  "forceOcr",
  "tableMode",
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
  "maxConcurrency",
  "addFrontmatter",
  "attachToItem",
  "exportFolderPath",
  "notifyOnComplete",
];

export function registerPrefsScripts(win: Window): void {
  // Keep a handle to the prefs window in addon.data — the template's addon.ts
  // already declares the slot.
  addon.data.prefs = addon.data.prefs ?? { window: win, columns: [], rows: [] };
  addon.data.prefs.window = win;

  bindTestConnection(win);
  bindPipelineToggle(win);
  bindPresetCustomToggle(win, "vlm");
  bindPresetCustomToggle(win, "pic");
  bindResetButton(win);
}

/** "Test Connection" button → calls /health, paints status label. */
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
  btn.addEventListener("command", async () => {
    const serverUrl =
      ((getPref("serverUrl") as string) ?? "").trim() ||
      "http://localhost:5001";
    label.textContent = "Testing…";
    label.style.color = "";
    const result = await testServerConnection(serverUrl);
    if (result.ok) {
      label.textContent = `Connected ✓  (${result.serverUrl})`;
      label.style.color = "var(--accent-green, #2a8000)";
    } else {
      label.textContent = `Cannot connect — ${result.message}`;
      label.style.color = "var(--accent-red, #c00)";
    }
  });
}

/** Pipeline radiogroup → show/hide the VLM section. */
function bindPipelineToggle(win: Window): void {
  const group = win.document.getElementById(
    "zotero-docling-pipeline-group",
  ) as HTMLElement | null;
  const vlmSection = win.document.getElementById(
    "zotero-docling-vlm-section",
  ) as HTMLElement | null;
  if (!vlmSection) return;

  const refresh = () => {
    const pipeline = (getPref("pipeline") as string) ?? "standard";
    vlmSection.hidden = pipeline !== "vlm";
  };
  if (group) group.addEventListener("command", refresh);
  refresh();
}

/**
 * "Reset to defaults" button → confirm dialog → clear every plugin pref.
 * Uses the Services.prompt cross-platform confirm dialog; user must opt-in.
 */
function bindResetButton(win: Window): void {
  const btn = win.document.getElementById(
    "zotero-docling-reset",
  ) as HTMLElement | null;
  if (!btn) {
    Zotero.debug(`${LOG} prefs: reset button not found`);
    return;
  }
  btn.addEventListener("command", () => {
    const Services = (globalThis as any).Services;
    const title =
      "Reset Zotero Docling preferences?"; /* fluent doesn't resolve here */
    const body =
      "This reverts every plugin preference (Server URL, auto-convert, pipeline, VLM preset, output, etc.) to its built-in default. Your Zotero library and existing markdown attachments are not touched.";
    const confirmed = Services?.prompt?.confirm?.(win, title, body) ?? true;
    if (!confirmed) return;

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

    // ProgressWindow toast for confirmation
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Zotero Docling");
      pw.addDescription("Preferences reset to defaults");
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
  });
}

/**
 * Each preset menulist has a hidden text input next to it.
 * Reveal it when "__custom__" is selected so the user can type any preset name.
 */
function bindPresetCustomToggle(win: Window, kind: "vlm" | "pic"): void {
  const menu = win.document.getElementById(
    `zotero-docling-${kind}-preset-menu`,
  ) as (HTMLElement & { value?: string }) | null;
  const custom = win.document.getElementById(
    `zotero-docling-${kind}-preset-custom`,
  ) as HTMLElement | null;
  if (!menu || !custom) return;

  const refresh = () => {
    custom.hidden = menu.value !== "__custom__";
  };
  menu.addEventListener("command", refresh);
  refresh();
}
