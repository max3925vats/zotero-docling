import { assert } from "chai";
import {
  clearAllSecrets,
  getSecret,
  loadSecrets,
  readStoredSecret,
  setSecret,
} from "../src/utils/secrets";

// Secrets moved out of prefs.js into Firefox's login manager (#17 spec §3.3,
// §3.9). These run against the real login manager of the test profile.

describe("secrets store", function () {
  afterEach(async function () {
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
    await setSecret("remote-picture-api", "persisted");
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
});
