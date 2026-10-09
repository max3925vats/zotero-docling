// Prefs-pane wiring for secret fields and the remote picture-description
// section (#17). Secrets aren't prefs any more, so these inputs are wired by
// hand instead of with preference="…".

import { getPref, setPref } from "../utils/prefs";
import {
  getSecret,
  secretsReady,
  setSecret,
  type SecretKey,
} from "../utils/secrets";
import { PROVIDERS, type ProviderId } from "./remotePictureApi";

const LOG = "[zotero-docling]";

/** Masked input ↔ login manager. Returns a refresher for Reset. */
export function bindSecretField(
  win: Window,
  inputId: string,
  key: SecretKey,
): () => void {
  const input = win.document.getElementById(inputId) as HTMLInputElement | null;
  // Set once the user types, so a late cache load never overwrites an edit.
  let dirty = false;
  const refresh = () => {
    if (input) input.value = getSecret(key);
  };
  if (!input) {
    Zotero.debug(`${LOG} prefs: ${inputId} not found`);
    return refresh;
  }
  refresh();
  // The cache may still be loading when the pane opens. Re-fill once it is
  // ready, unless the user has already started typing.
  void secretsReady()
    .then(() => {
      if (!dirty) refresh();
    })
    .catch(() => {});
  input.addEventListener("input", () => {
    dirty = true;
  });
  // Save on "change" (blur or Enter), not on each keystroke, so the store
  // isn't written for every character typed.
  input.addEventListener("change", () => {
    void setSecret(key, input.value.trim()).catch((e) =>
      Zotero.debug(`${LOG} saving ${key} failed: ${(e as Error).message}`),
    );
  });
  return refresh;
}

/** URL to fill in when a preset provider is chosen; null for Custom. */
export function providerDefaults(provider: ProviderId): { url: string } | null {
  if (provider === "custom") return null;
  return { url: PROVIDERS[provider].url };
}

/**
 * Show the remote fields only when the gate is on, disable the local preset
 * (it isn't sent then), and fill the URL when a preset provider is picked.
 */
export function bindRemotePicSection(win: Window): () => void {
  const doc = win.document;
  const gate = doc.getElementById("zotero-docling-remote-pic-enabled") as any;
  const section = doc.getElementById(
    "zotero-docling-remote-pic-section",
  ) as HTMLElement | null;
  const provider = doc.getElementById(
    "zotero-docling-remote-pic-provider",
  ) as any;
  const url = doc.getElementById(
    "zotero-docling-remote-pic-url",
  ) as HTMLInputElement | null;
  const localPreset = doc.getElementById(
    "zotero-docling-pic-preset-menu",
  ) as any;
  const refreshKey = bindSecretField(
    win,
    "zotero-docling-remote-pic-key",
    "remote-picture-api",
  );

  const refresh = () => {
    const on = Boolean(getPref("remotePicApiEnabled") ?? false);
    if (section) section.hidden = !on;
    if (localPreset) localPreset.disabled = on;
    refreshKey();
  };
  // The checkbox writes its pref after "command" fires, so read it next tick.
  gate?.addEventListener("command", () => setTimeout(refresh, 0));
  provider?.addEventListener("command", () => {
    const d = providerDefaults((provider.value || "custom") as ProviderId);
    if (!d) return;
    setPref("remotePicApiUrl", d.url);
    if (url) url.value = d.url;
  });
  refresh();
  return refresh;
}
