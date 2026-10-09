// docling-serve credentials: the auth header sent on every request, and the
// two one-time migrations (URL credentials → auth settings; plaintext
// authSecret pref → login manager). Non-secret auth settings (scheme,
// username, header name) remain ordinary prefs.

import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getSecret, readStoredSecret, setSecret } from "../utils/secrets";

const LEGACY_PREF = `${config.prefsPrefix}.authSecret`;

/** The pre-0.6.0 plaintext pref (no longer declared in prefs.js). */
export function readLegacyAuthSecretPref(): string {
  return String(Zotero.Prefs.get(LEGACY_PREF, true) ?? "");
}

export function clearLegacyAuthSecretPref(): void {
  Zotero.Prefs.clear(LEGACY_PREF, true);
}

/** Store first; a leftover pref only when migration couldn't run. */
function authSecret(): string {
  return getSecret("docling-serve-auth") || readLegacyAuthSecretPref();
}

/**
 * Move the plaintext authSecret pref into the login manager. The pref is
 * cleared only after the stored value reads back identical, so a failed
 * write never loses the credential (same idea as Re-convert's
 * convert-then-trash). "kept" means: still in prefs, retried next startup.
 */
export async function migrateAuthSecretPref(): Promise<
  "none" | "migrated" | "kept"
> {
  const value = readLegacyAuthSecretPref();
  if (!value) return "none";
  try {
    await setSecret("docling-serve-auth", value);
    if ((await readStoredSecret("docling-serve-auth")) !== value) return "kept";
  } catch (e) {
    Zotero.debug(
      `[zotero-docling] authSecret migration failed, keeping pref: ${(e as Error).message}`,
    );
    return "kept";
  }
  clearLegacyAuthSecretPref();
  return "migrated";
}

/**
 * One-time cleanup for servers configured as http://user:pass@host. URL
 * credentials are now rejected (they were silently dropped before), so move
 * them into the Basic auth settings — unless another auth scheme is already
 * set up, in which case keep that and just strip the URL. Without this,
 * auto-convert for such users would only report "docling-serve isn't
 * running".
 */
export async function migrateUrlCredentials(): Promise<void> {
  const raw = ((getPref("serverUrl") as string) ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return;
  }
  if (!parsed.username && !parsed.password) return;
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  parsed.username = "";
  parsed.password = "";
  const scheme = ((getPref("authScheme") as string) ?? "none").toLowerCase();
  if (scheme === "none" || scheme === "") {
    setPref("authScheme", "basic");
    setPref("authUsername", user);
    await setSecret("docling-serve-auth", pass);
  }
  setPref("serverUrl", parsed.toString().replace(/\/+$/, ""));
  Zotero.debug("[zotero-docling] moved credentials out of the server URL");
}

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, never a throw). */
function utf8Bytes(s: string): Uint8Array | number[] {
  const Encoder = (globalThis as any).TextEncoder;
  if (Encoder) return new Encoder().encode(s);
  // Sandbox without TextEncoder: same result via encodeURIComponent.
  const safe = s.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "\ufffd",
  );
  return Array.from(
    encodeURIComponent(safe).replace(/%([0-9A-F]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    ),
  ).map((c) => c.charCodeAt(0));
}

/**
 * Build the auth header(s) to send with every request based on the configured
 * `authScheme` pref. Returns an empty object when scheme is "none" (the default).
 *
 * Wire format:
 *   - bearer:  Authorization: Bearer <token>
 *   - basic:   Authorization: Basic <base64(username:password)>
 *   - custom:  <header-name>: <header-value>  (single header, v1)
 *
 * The secret (token / password / header value) is stored in the login
 * manager — see SECURITY.md. The other auth settings are ordinary prefs.
 */
export function buildAuthHeader(): Record<string, string> {
  const scheme = ((getPref("authScheme") ?? "none") as string).toLowerCase();
  if (scheme === "none" || scheme === "") return {};

  if (scheme === "bearer") {
    const token = authSecret().trim();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  if (scheme === "basic") {
    const user = ((getPref("authUsername") as string) ?? "").trim();
    const pass = authSecret();
    if (!user && !pass) return {};
    // Basic auth is base64 of the UTF-8 bytes. btoa() only takes Latin-1, so
    // non-ASCII credentials (é, €, ...) were mis-encoded or threw outright.
    const bytes = utf8Bytes(`${user}:${pass}`);
    let latin1 = "";
    for (const b of bytes) latin1 += String.fromCharCode(b);
    const encoded = (globalThis as any).btoa(latin1);
    return { Authorization: `Basic ${encoded}` };
  }

  if (scheme === "custom") {
    const name = ((getPref("authHeaderName") as string) ?? "").trim();
    const value = authSecret().trim();
    if (!name || !value) return {};
    return { [name]: value };
  }

  return {};
}
