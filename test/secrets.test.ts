import { assert } from "chai";
import {
  _resetSecretsCacheForTests,
  clearAllSecrets,
  getSecret,
  loadSecrets,
  providerKeyName,
  readStoredSecret,
  secretsReady,
  setLoginManagerForTests,
  secretWritesSettled,
  setSecret,
} from "../src/utils/secrets";

// Secrets moved out of prefs.js into Firefox's login manager (#17 spec §3.3,
// §3.9). These run against the real login manager of the test profile.

const OPENAI = providerKeyName("openai");

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
    await setSecret(OPENAI, "sk-test-123");
    assert.strictEqual(getSecret(OPENAI), "sk-test-123");
    assert.strictEqual(await readStoredSecret(OPENAI), "sk-test-123");
  });

  it("keeps the two keys separate", async function () {
    await setSecret(OPENAI, "provider-key");
    await setSecret("docling-serve-auth", "server-token");
    assert.strictEqual(getSecret(OPENAI), "provider-key");
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
    await setSecret(OPENAI, "persisted");
    _resetSecretsCacheForTests();
    assert.strictEqual(getSecret(OPENAI), "");
    await loadSecrets();
    assert.strictEqual(getSecret(OPENAI), "persisted");
  });

  it("clearAllSecrets empties both store and cache", async function () {
    await setSecret(OPENAI, "a");
    await setSecret("docling-serve-auth", "b");
    await clearAllSecrets();
    assert.strictEqual(getSecret(OPENAI), "");
    assert.strictEqual(await readStoredSecret("docling-serve-auth"), "");
  });

  it("a failed load rejects once, then a retry succeeds", async function () {
    await setSecret(OPENAI, "kept");
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
    assert.strictEqual(getSecret(OPENAI), "kept");
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
      setSecret(OPENAI, "first"),
      setSecret(OPENAI, "second"),
    ]);
    const Services = (globalThis as any).Services;
    const found = await Services.logins.searchLoginsAsync({
      origin: "chrome://zotero-docling",
      httpRealm: "remote-picture-api:openai",
    });
    assert.lengthOf(found, 1);
    assert.strictEqual(found[0].password, "second");
    assert.strictEqual(getSecret(OPENAI), "second");
  });

  it("secretWritesSettled waits for a write that was not awaited", async function () {
    // The pane saves without awaiting; a reader that settles first must see
    // the new value, not the one from before the write.
    void setSecret(OPENAI, "fresh");
    await secretWritesSettled();
    assert.strictEqual(getSecret(OPENAI), "fresh");
    void setSecret("docling-serve-auth", "tok");
    await secretWritesSettled("docling-serve-auth");
    assert.strictEqual(getSecret("docling-serve-auth"), "tok");
  });

  it("stores each provider's key in its own slot", async function () {
    await setSecret(providerKeyName("openai"), "sk-openai");
    assert.strictEqual(getSecret(providerKeyName("ollama")), "");
    _resetSecretsCacheForTests();
    await loadSecrets();
    assert.strictEqual(getSecret(providerKeyName("openai")), "sk-openai");
    await clearAllSecrets();
    assert.strictEqual(await readStoredSecret(providerKeyName("openai")), "");
  });
});
