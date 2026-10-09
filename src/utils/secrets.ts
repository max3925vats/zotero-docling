// Secret storage in Firefox's login manager (Services.logins), the same place
// Zotero keeps its own sync API key. Values are encrypted in logins.json —
// out of prefs.js, the Config Editor and pasted prefs — but anyone who copies
// the whole profile can still decrypt them (Zotero doesn't support a primary
// password). See SECURITY.md.
//
// The login manager is async, but buildAuthHeader() is sync and runs on every
// request, so values are cached in memory: loaded once at startup, updated on
// every write.

export type SecretKey = "docling-serve-auth" | "remote-picture-api";

const ORIGIN = "chrome://zotero-docling";
const USERNAME = "zotero-docling";
const ALL_KEYS: ReadonlyArray<SecretKey> = [
  "docling-serve-auth",
  "remote-picture-api",
];

const cache = new Map<SecretKey, string>();
let ready: Promise<void> | null = null;

// Test seam: lets tests simulate a broken store. Production never sets it.
let loginsOverrideForTests: unknown | null = null;
export function setLoginManagerForTests(lm: unknown | null): void {
  loginsOverrideForTests = lm;
}

/** Firefox globals from the plugin sandbox (no bare `Services` there). */
function logins(): any {
  if (loginsOverrideForTests) return loginsOverrideForTests;
  const lm = (globalThis as any).Services?.logins;
  if (!lm) throw new Error("Login manager unavailable");
  return lm;
}

function newLoginInfo(key: SecretKey, value: string): unknown {
  const C = (globalThis as any).Components;
  const LoginInfo = C.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    C.interfaces.nsILoginInfo,
    "init",
  );
  // (origin, formActionOrigin, httpRealm, username, password, usernameField, passwordField)
  return new LoginInfo(ORIGIN, null, key, USERNAME, value, "", "");
}

async function findLogins(key: SecretKey): Promise<any[]> {
  return (
    (await logins().searchLoginsAsync({ origin: ORIGIN, httpRealm: key })) ?? []
  );
}

/** Read the stored value (bypasses the cache). "" when absent. */
export async function readStoredSecret(key: SecretKey): Promise<string> {
  const found = await findLogins(key);
  return found.length ? String(found[0].password ?? "") : "";
}

/** Fill the cache from the login manager. Safe to call again. */
export function loadSecrets(): Promise<void> {
  ready = (async () => {
    for (const key of ALL_KEYS) {
      cache.set(key, await readStoredSecret(key));
    }
  })();
  return ready;
}

/** Resolves once loadSecrets() has finished (starts it if nobody has). */
export function secretsReady(): Promise<void> {
  return ready ?? loadSecrets();
}

/** Cached value; "" if unset or not loaded yet. */
export function getSecret(key: SecretKey): string {
  return cache.get(key) ?? "";
}

/** Store (or, for "", remove) a secret. Replaces rather than duplicates. */
export async function setSecret(key: SecretKey, value: string): Promise<void> {
  for (const old of await findLogins(key)) {
    await logins().removeLoginAsync(old);
  }
  if (value) await logins().addLoginAsync(newLoginInfo(key, value));
  cache.set(key, value);
}

/** Remove every plugin secret (Reset to defaults). */
export async function clearAllSecrets(): Promise<void> {
  for (const key of ALL_KEYS) await setSecret(key, "");
}
