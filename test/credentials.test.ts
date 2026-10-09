import { assert } from "chai";
import { config } from "../package.json";
import {
  buildAuthHeader,
  migrateAuthSecretPref,
  migrateUrlCredentials,
} from "../src/modules/credentials";
import {
  clearAllSecrets,
  getSecret,
  setLoginManagerForTests,
  setSecret,
} from "../src/utils/secrets";

// Spec §3.9: authSecret moves from prefs.js to the login manager,
// write-then-verify-then-clear, and the auth header reads the store.

const PREFIX = config.prefsPrefix;
const KEYS = [
  "serverUrl",
  "authScheme",
  "authUsername",
  "authSecret",
  "authHeaderName",
];
const set = (k: string, v: unknown) =>
  Zotero.Prefs.set(`${PREFIX}.${k}`, v as never, true);
const get = (k: string) => Zotero.Prefs.get(`${PREFIX}.${k}`, true);

describe("credentials", function () {
  afterEach(async function () {
    for (const k of KEYS) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await clearAllSecrets();
  });

  describe("migrateAuthSecretPref", function () {
    it("moves a plaintext secret into the store and clears the pref", async function () {
      set("authSecret", "tok-123");
      const r = await migrateAuthSecretPref();
      assert.strictEqual(r, "migrated");
      assert.strictEqual(getSecret("docling-serve-auth"), "tok-123");
      assert.isUndefined(get("authSecret"));
    });

    it("does nothing when there is no pref", async function () {
      assert.strictEqual(await migrateAuthSecretPref(), "none");
    });

    it("is idempotent: a second run finds nothing to do", async function () {
      set("authSecret", "tok");
      await migrateAuthSecretPref();
      assert.strictEqual(await migrateAuthSecretPref(), "none");
      assert.strictEqual(getSecret("docling-serve-auth"), "tok");
    });

    it("keeps the pref when the store write fails", async function () {
      set("authSecret", "keep-me");
      setLoginManagerForTests({
        searchLoginsAsync: async () => [],
        removeLoginAsync: async () => undefined,
        addLoginAsync: async () => {
          throw new Error("store broken");
        },
      });
      try {
        const r = await migrateAuthSecretPref();
        assert.strictEqual(r, "kept");
        assert.strictEqual(get("authSecret"), "keep-me");
      } finally {
        setLoginManagerForTests(null);
      }
    });
  });

  describe("buildAuthHeader", function () {
    it("reads a bearer token from the store", async function () {
      set("authScheme", "bearer");
      await setSecret("docling-serve-auth", "abc");
      assert.deepEqual(buildAuthHeader(), { Authorization: "Bearer abc" });
    });

    it("encodes non-ASCII basic credentials from the store as UTF-8", async function () {
      set("authScheme", "basic");
      set("authUsername", "user");
      await setSecret("docling-serve-auth", "pass€");
      assert.deepEqual(buildAuthHeader(), {
        Authorization: "Basic dXNlcjpwYXNz4oKs",
      });
    });

    it("sends a custom header from the store", async function () {
      set("authScheme", "custom");
      set("authHeaderName", "X-Api-Key");
      await setSecret("docling-serve-auth", "k");
      assert.deepEqual(buildAuthHeader(), { "X-Api-Key": "k" });
    });

    it("falls back to a leftover pref if migration has not happened", function () {
      set("authScheme", "bearer");
      set("authSecret", "legacy");
      assert.deepEqual(buildAuthHeader(), { Authorization: "Bearer legacy" });
    });
  });

  describe("migrateUrlCredentials", function () {
    it("moves URL credentials into basic auth with the password in the store", async function () {
      set("serverUrl", "http://bob:s%40cret@docling.test:5001");
      await migrateUrlCredentials();
      assert.strictEqual(get("serverUrl"), "http://docling.test:5001");
      assert.strictEqual(get("authScheme"), "basic");
      assert.strictEqual(get("authUsername"), "bob");
      assert.strictEqual(getSecret("docling-serve-auth"), "s@cret");
      assert.isUndefined(get("authSecret"));
    });
  });
});
