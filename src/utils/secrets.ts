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

// Bumped on every write to a key. A load that started before a write must not
// overwrite the cache with what it read earlier (that would roll back the write).
const generation = new Map<SecretKey, number>();

// Writes to one key run one at a time. Without this, two find→remove→add
// sequences can interleave and leave two logins for the same key.
const writeChains = new Map<SecretKey, Promise<void>>();

// Test seam: lets tests simulate a broken store. Production never sets it.
let loginsOverrideForTests: unknown | null = null;
export function setLoginManagerForTests(lm: unknown | null): void {
  loginsOverrideForTests = lm;
}

// Test-only: forget the cache and any load in progress, without touching the
// store, so a test can prove loadSecrets() really reads from the store.
export function _resetSecretsCacheForTests(): void {
  cache.clear();
  ready = null;
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

/**
 * Remove one login. Firefox 140's nsILoginManager only has the synchronous
 * removeLogin(); removeLoginAsync() is used when a store provides it (tests,
 * newer Firefox), so both shapes work.
 */
async function removeOne(login: unknown): Promise<void> {
  const lm = logins();
  if (typeof lm.removeLoginAsync === "function") {
    await lm.removeLoginAsync(login);
  } else {
    lm.removeLogin(login);
  }
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
  // Snapshot the write generations: a key written while we read must keep
  // the newer value instead of being overwritten by what we read.
  const started = new Map(generation);
  const load: Promise<void> = (async () => {
    for (const key of ALL_KEYS) {
      const value = await readStoredSecret(key);
      if ((generation.get(key) ?? 0) === (started.get(key) ?? 0)) {
        cache.set(key, value);
      }
    }
  })().catch((err: unknown) => {
    // Clear the failed attempt so the next secretsReady()/loadSecrets() retries
    // instead of returning the same rejection forever.
    if (ready === load) ready = null;
    throw err;
  });
  ready = load;
  return load;
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
export function setSecret(key: SecretKey, value: string): Promise<void> {
  // Queue behind any earlier write to this key. The stored chain never rejects,
  // so one failed write does not block later ones.
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.then(() => writeSecret(key, value));
  writeChains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

async function writeSecret(key: SecretKey, value: string): Promise<void> {
  generation.set(key, (generation.get(key) ?? 0) + 1);
  const old = await findLogins(key);
  try {
    for (const login of old) await removeOne(login);
    // The store has no login for this key now, so the cache must not still
    // report the old value.
    cache.set(key, "");
    if (value) await logins().addLoginAsync(newLoginInfo(key, value));
  } catch (err) {
    await restoreOldLogin(key, old);
    // Resync the cache to whatever the store actually holds after the failure.
    cache.set(key, await readStoredSecret(key).catch(() => ""));
    throw err;
  }
  cache.set(key, value);
}

/** Best effort: put the previous login back if the failed write removed it. */
async function restoreOldLogin(key: SecretKey, old: any[]): Promise<void> {
  if (old.length === 0) return;
  try {
    if ((await findLogins(key)).length === 0) {
      await logins().addLoginAsync(old[0]);
    }
  } catch {
    // The caller's resync reports what the store really holds, so there is
    // nothing more to do here.
  }
}

/** Remove every plugin secret (Reset to defaults). */
export async function clearAllSecrets(): Promise<void> {
  for (const key of ALL_KEYS) await setSecret(key, "");
}
