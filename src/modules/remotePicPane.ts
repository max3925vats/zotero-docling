// Prefs-pane wiring for secret fields and the remote picture-description
// section (#17). Secrets aren't prefs any more, so these inputs are wired by
// hand instead of with preference="…".

import { getLocaleID } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  getSecret,
  providerKeyName,
  registerSecretFlush,
  secretsReady,
  secretWritesSettled,
  setSecret,
  type SecretKey,
} from "../utils/secrets";
import { getWebApis } from "./convert";
import {
  PROVIDERS,
  readRemoteSettings,
  testRemoteApi,
  type ProviderId,
} from "./remotePictureApi";

const LOG = "[zotero-docling]";

// How long typing must pause before the field is saved. Short enough that a
// quick Test click or window close finds the value saved (both also flush).
const SAVE_DEBOUNCE_MS = 400;

/** A refresher (for Reset) that can also save a pending edit right away. */
export type SecretFieldBinding = (() => void) & { flush: () => void };

/**
 * Masked input ↔ login manager. `key` may be a function so one input can
 * follow the selected provider's slot. Returns a refresher for Reset.
 */
export function bindSecretField(
  win: Window,
  inputId: string,
  key: SecretKey | (() => SecretKey),
): SecretFieldBinding {
  const keyOf = typeof key === "function" ? key : () => key;
  const input = win.document.getElementById(inputId) as HTMLInputElement | null;
  // The slot the input's current text belongs to. A pending edit is saved
  // here even if the provider has changed since.
  let boundKey = keyOf();
  // Set once the user types, so a late cache load never overwrites an edit.
  let dirty = false;
  // Typed since the last save.
  let unsaved = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    cancelTimer();
    if (!input || !unsaved) return;
    unsaved = false;
    const k = boundKey;
    void setSecret(k, input.value.trim()).catch((e) =>
      Zotero.debug(`${LOG} saving ${k} failed: ${(e as Error).message}`),
    );
  };
  // Re-reads the store for the current slot and drops any unsaved edit:
  // Reset calls this after clearing, and must not have it re-saved.
  const refresh = () => {
    cancelTimer();
    unsaved = false;
    boundKey = keyOf();
    if (input) input.value = getSecret(boundKey);
  };
  const binding = Object.assign(refresh, { flush });
  if (!input) {
    Zotero.debug(`${LOG} prefs: ${inputId} not found`);
    return binding;
  }
  refresh();
  // The cache may still be loading when the pane opens. Re-fill once it is
  // ready, unless the user has already started typing.
  void secretsReady()
    .then(() => {
      if (!dirty) refresh();
    })
    .catch(() => {});
  // Save shortly after typing stops, and at once on "change" (blur/Enter).
  // "change" alone loses edits: closing the window may never fire it, and a
  // Test click could read the old value.
  input.addEventListener("input", () => {
    dirty = true;
    unsaved = true;
    cancelTimer();
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  });
  input.addEventListener("change", flush);
  const unregister = registerSecretFlush(flush);
  const onClose = () => {
    flush();
    unregister();
  };
  win.addEventListener?.("unload", onClose);
  win.addEventListener?.("pagehide", onClose);
  return binding;
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
  // The key field shows the slot of the provider currently selected. The
  // menulist's value updates before its pref, so prefer the element.
  const currentProvider = (): ProviderId => {
    const raw = String(provider?.value || readRemoteSettings().provider);
    return (raw in PROVIDERS ? raw : "custom") as ProviderId;
  };
  const keyField = bindSecretField(win, "zotero-docling-remote-pic-key", () =>
    providerKeyName(currentProvider()),
  );

  const refresh = () => {
    const on = Boolean(getPref("remotePicApiEnabled") ?? false);
    if (section) section.hidden = !on;
    if (localPreset) localPreset.disabled = on;
    keyField();
  };
  // The checkbox writes its pref after "command" fires, so read it next tick.
  gate?.addEventListener("command", () => setTimeout(refresh, 0));
  provider?.addEventListener("command", () => {
    // Save a pending edit to the old provider's slot, then show the new one's.
    keyField.flush();
    keyField();
    const d = providerDefaults(currentProvider());
    if (!d) return;
    setPref("remotePicApiUrl", d.url);
    if (url) url.value = d.url;
  });
  refresh();
  return refresh;
}

/** Confirm dialog for paid providers; Cancel is the default button. */
async function confirmPaidTest(
  win: Window,
  provider: string,
  url: string,
): Promise<boolean> {
  const Services = (globalThis as any).Services;
  if (!Services?.prompt?.confirmEx) return false; // fail closed
  let [title, body, send] = [
    `Test connection to ${provider}?`,
    `This sends one request to ${url} using your API key, to check the URL, the key and the model name. Listing models is free, so no credits are used and no PDF or image is sent.`,
    "Send test request",
  ];
  try {
    const v = await (win.document as any).l10n?.formatValues?.([
      { id: getLocaleID("pref-remote-pic-confirm-title"), args: { provider } },
      { id: getLocaleID("pref-remote-pic-confirm-body"), args: { url } },
      { id: getLocaleID("pref-remote-pic-confirm-send") },
    ]);
    if (v?.[0]) title = v[0];
    if (v?.[1]) body = v[1];
    if (v?.[2]) send = v[2];
  } catch {
    /* keep English */
  }
  const P = Services.prompt;
  const flags =
    P.BUTTON_POS_0 * P.BUTTON_TITLE_IS_STRING +
    P.BUTTON_POS_1 * P.BUTTON_TITLE_CANCEL +
    P.BUTTON_POS_1_DEFAULT;
  // confirmEx returns the index of the pressed button: 0 = Send.
  return P.confirmEx(win, title, body, flags, send, null, null, null, {}) === 0;
}

export function bindRemotePicTest(win: Window): void {
  const btn = win.document.getElementById("zotero-docling-remote-pic-test");
  const out = win.document.getElementById(
    "zotero-docling-remote-pic-test-result",
  );
  if (!btn || !out) return;
  btn.addEventListener("command", async () => {
    out.textContent = "Testing…";
    // Save a just-typed key before reading it.
    await secretWritesSettled();
    const s = readRemoteSettings();
    const r = await testRemoteApi(
      s,
      getSecret(providerKeyName(s.provider)),
      (p, u) => confirmPaidTest(win, p, u),
      getWebApis(),
    );
    if ("cancelled" in r) out.textContent = "Cancelled — nothing was sent.";
    else if (!r.ok) out.textContent = `✗ ${r.message}`;
    else
      out.textContent = r.modelListed
        ? `✓ Connected; model "${s.model}" found.`
        : `✓ Connected, but "${s.model}" isn't in the provider's model list — check the name.`;
  });
}
