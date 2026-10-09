// Prefs-pane wiring for secret fields and the remote picture-description
// section (#17). Secrets aren't prefs any more, so these inputs are wired by
// hand instead of with preference="…".

import { getLocaleID } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  getSecret,
  secretsReady,
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
    const s = readRemoteSettings();
    const r = await testRemoteApi(
      s,
      getSecret("remote-picture-api"),
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
