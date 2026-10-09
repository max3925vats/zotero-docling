import { assert } from "chai";
import {
  _resetSecretsCacheForTests,
  clearAllSecrets,
  getSecret,
  loadSecrets,
  readStoredSecret,
  secretsReady,
  secretWritesSettled,
  setLoginManagerForTests,
  setSecret,
} from "../src/utils/secrets";

// Secrets moved out of prefs.js into Firefox's login manager (#17 spec §3.3,
// §3.9). These run against the real login manager of the test profile.

/** Resolves to the rejection, or fails the test if the promise resolves. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected the promise to reject");
}

describe("secrets store", function () {
  afterEach(async function () {
    setLoginManagerForTests(null);
    await clearAllSecrets();
  });

  it("round-trips a value through the login manager and the cache", async function () {
    await setSecret("remote-picture-api", "sk-test-123");
    assert.strictEqual(getSecret("remote-picture-api"), "sk-test-123");
    assert.strictEqual(
      await readStoredSecret("remote-picture-api"),
      "sk-test-123",
    );
  });

  it("keeps the two keys separate", async function () {
    await setSecret("remote-picture-api", "provider-key");
    await setSecret("docling-serve-auth", "server-token");
    assert.strictEqual(getSecret("remote-picture-api"), "provider-key");
    assert.strictEqual(getSecret("docling-serve-auth"), "server-token");
  });

  it("replaces an existing value instead of adding a second login", async function () {
    await setSecret("docling-serve-auth", "old");
    await setSecret("docling-serve-auth", "new");
    const Services = (globalThis as any).Services;
    const found = await Services.logins.searchLoginsAsync({
      origin: "chrome://zotero-docling",
      httpRealm: "docling-serve-auth",
    });
    assert.lengthOf(found, 1);
    assert.strictEqual(found[0].password, "new");
  });

  it("removes the login when set to an empty string", async function () {
    await setSecret("docling-serve-auth", "x");
    await setSecret("docling-serve-auth", "");
    assert.strictEqual(getSecret("docling-serve-auth"), "");
    assert.strictEqual(await readStoredSecret("docling-serve-auth"), "");
  });

  it("loadSecrets fills the cache from what is stored", async function () {
    // Store the value without touching the cache, then clear the cache, so the
    // only way the assertion can pass is if loadSecrets() reads the store.
    await setSecret("remote-picture-api", "persisted");
    _resetSecretsCacheForTests();
    assert.strictEqual(getSecret("remote-picture-api"), "");
    await loadSecrets();
    assert.strictEqual(getSecret("remote-picture-api"), "persisted");
  });

  it("clearAllSecrets empties both store and cache", async function () {
    await setSecret("remote-picture-api", "a");
    await setSecret("docling-serve-auth", "b");
    await clearAllSecrets();
    assert.strictEqual(getSecret("remote-picture-api"), "");
    assert.strictEqual(await readStoredSecret("docling-serve-auth"), "");
  });

  it("a failed load rejects once, then a retry succeeds", async function () {
    await setSecret("remote-picture-api", "kept");
    _resetSecretsCacheForTests();
    setLoginManagerForTests({
      searchLoginsAsync: async () => {
        throw new Error("store unavailable");
      },
    });
    try {
      const err = await rejectionOf(secretsReady());
      assert.match(String(err), /store unavailable/);
    } finally {
      setLoginManagerForTests(null);
    }
    // The store is back: the failed attempt must not poison secretsReady().
    await secretsReady();
    assert.strictEqual(getSecret("remote-picture-api"), "kept");
  });

  it("a failed add restores the previous login and keeps the cache honest", async function () {
    await setSecret("docling-serve-auth", "old");
    const real = (globalThis as any).Services.logins;
    let adds = 0;
    setLoginManagerForTests({
      searchLoginsAsync: (q: unknown) => real.searchLoginsAsync(q),
      // Sync removeLogin only, like real Firefox 140 (no removeLoginAsync).
      removeLogin: (l: unknown) => real.removeLogin(l),
      addLoginAsync: (l: unknown) => {
        adds += 1;
        // Fail only the first add, so the restore (second add) can succeed.
        if (adds === 1) throw new Error("disk full");
        return real.addLoginAsync(l);
      },
    });
    try {
      const err = await rejectionOf(setSecret("docling-serve-auth", "new"));
      assert.match(String(err), /disk full/);
    } finally {
      setLoginManagerForTests(null);
    }
    assert.strictEqual(getSecret("docling-serve-auth"), "old");
    assert.strictEqual(await readStoredSecret("docling-serve-auth"), "old");
  });

  it("a failed add with a failed restore leaves the cache empty, matching the store", async function () {
    await setSecret("docling-serve-auth", "old");
    const real = (globalThis as any).Services.logins;
    setLoginManagerForTests({
      searchLoginsAsync: (q: unknown) => real.searchLoginsAsync(q),
      removeLogin: (l: unknown) => real.removeLogin(l),
      addLoginAsync: () => {
        throw new Error("disk full");
      },
    });
    try {
      await rejectionOf(setSecret("docling-serve-auth", "new"));
    } finally {
      setLoginManagerForTests(null);
    }
    assert.strictEqual(getSecret("docling-serve-auth"), "");
    assert.strictEqual(await readStoredSecret("docling-serve-auth"), "");
  });

  it("concurrent writes to one key leave exactly one login with the last value", async function () {
    await Promise.all([
      setSecret("remote-picture-api", "first"),
      setSecret("remote-picture-api", "second"),
    ]);
    const Services = (globalThis as any).Services;
    const found = await Services.logins.searchLoginsAsync({
      origin: "chrome://zotero-docling",
      httpRealm: "remote-picture-api",
    });
    assert.lengthOf(found, 1);
    assert.strictEqual(found[0].password, "second");
    assert.strictEqual(getSecret("remote-picture-api"), "second");
  });

  it("secretWritesSettled waits for a write that was not awaited", async function () {
    // The pane saves without awaiting; a reader that settles first must see
    // the new value, not the one from before the write.
    void setSecret("remote-picture-api", "fresh");
    await secretWritesSettled();
    assert.strictEqual(getSecret("remote-picture-api"), "fresh");
    void setSecret("docling-serve-auth", "tok");
    await secretWritesSettled("docling-serve-auth");
    assert.strictEqual(getSecret("docling-serve-auth"), "tok");
  });
});
