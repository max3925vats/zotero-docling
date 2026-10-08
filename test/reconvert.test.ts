import { assert } from "chai";
import { config } from "../package.json";
import { setFetchOverrideForTests } from "../src/modules/convert";
import { runBatch } from "../src/modules/menu";
import { findMatchingMdChild } from "../src/utils/zotero";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Audit H3: Re-convert used to permanently erase the existing .md BEFORE
// converting, so a failed conversion (server down, timeout, error) left the
// user with nothing. Now: convert first, and only after the new .md is
// attached move the old one to Zotero's trash (recoverable).

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "attachToItem",
  "exportFolderPath",
  "useAsyncEndpoint",
  "confirmReconvert",
  "notifyOnComplete",
];

function setPref(key: string, value: unknown): void {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value as never, true);
}

/** Scripted docling-serve: /health is always up; convert returns `convert`. */
function stubServer(convert: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return convert();
  }) as typeof fetch;
}

const success = () =>
  new Response(
    JSON.stringify({
      status: "success",
      document: { md_content: "# new conversion" },
      processing_time: 1,
    }),
    { status: 200 },
  );

const failure = () =>
  new Response(JSON.stringify({ detail: "boom" }), { status: 500 });

describe("Re-convert (replace)", function () {
  this.timeout(20000);

  // runBatch reads the plugin's sandbox globals (`addon`, `ztoolkit`). The
  // test bundle runs in a window realm without them, so point them at the
  // live plugin instance the harness already loaded.
  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    // A getter, not a snapshot: window loads replace addon.data.ztoolkit.
    Object.defineProperty(g, "ztoolkit", {
      configurable: true,
      get: () => g.addon.data.ztoolkit,
    });
  });

  beforeEach(function () {
    setPref("serverUrl", "http://docling.test");
    setPref("addFrontmatter", false);
    setPref("attachToItem", true);
    setPref("exportFolderPath", "");
    setPref("useAsyncEndpoint", false);
    setPref("confirmReconvert", false);
    setPref("notifyOnComplete", false);
  });

  afterEach(async function () {
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await cleanupTestItems();
  });

  it("keeps the existing .md untouched when the conversion fails", async function () {
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(
      parent,
      "paper.pdf",
      "application/pdf",
    );
    const oldMd = await makeFileAttachment(
      parent,
      "paper.md",
      "text/markdown",
      "old",
    );
    setFetchOverrideForTests(stubServer(failure));

    await runBatch([pdf], { force: true, menuLabel: "test" });

    const still = Zotero.Items.get(oldMd.id);
    assert.ok(still, "old .md must still exist");
    assert.isFalse(still && still.deleted, "old .md must not be trashed");
    assert.strictEqual(
      findMatchingMdChild(parent.id, "paper.pdf")?.id,
      oldMd.id,
    );
  });

  it("attaches the new .md and moves the old one to the trash on success", async function () {
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(
      parent,
      "paper.pdf",
      "application/pdf",
    );
    const oldMd = await makeFileAttachment(
      parent,
      "paper.md",
      "text/markdown",
      "old",
    );
    setFetchOverrideForTests(stubServer(success));

    await runBatch([pdf], { force: true, menuLabel: "test" });

    const old = Zotero.Items.get(oldMd.id);
    assert.ok(old, "old .md is trashed, not erased");
    assert.isTrue(old && old.deleted, "old .md must be in the trash");

    const fresh = findMatchingMdChild(parent.id, "paper.pdf");
    assert.ok(fresh, "a new .md must be attached");
    assert.notStrictEqual(fresh?.id, oldMd.id);
    const path = fresh?.getFilePath();
    assert.include(await IOUtils.readUTF8(path as string), "# new conversion");
  });
});
