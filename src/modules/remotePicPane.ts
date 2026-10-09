// Prefs-pane wiring for secret fields and the remote picture-description
// section (#17). Secrets aren't prefs any more, so these inputs are wired by
// hand instead of with preference="…".

import {
  getSecret,
  secretsReady,
  setSecret,
  type SecretKey,
} from "../utils/secrets";

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
