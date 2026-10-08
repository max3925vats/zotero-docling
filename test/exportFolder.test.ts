import { assert } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Audit M5: a failed write to the export folder was logged and swallowed,
// and the result was still "ok". With "Attach to item" off, the converted
// markdown went nowhere and the user was told it succeeded.

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "attachToItem",
  "exportFolderPath",
  "useAsyncEndpoint",
];

const success = (async () =>
  new Response(
    JSON.stringify({
      status: "success",
      document: { md_content: "# converted" },
      processing_time: 1,
    }),
    { status: 200 },
  )) as unknown as typeof fetch;

describe("export folder failures", function () {
  this.timeout(20000);
  let blocker: string;

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    g.ztoolkit = g.addon.data.ztoolkit;
  });

  beforeEach(async function () {
    // A regular file: any "folder" beneath it can't be created or written.
    blocker = PathUtils.join(PathUtils.tempDir, `zd-blocker-${Date.now()}`);
    await IOUtils.writeUTF8(blocker, "not a directory");
    Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
    Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
    Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, false, true);
    Zotero.Prefs.set(
      `${PREFIX}.exportFolderPath`,
      PathUtils.join(blocker, "out"),
      true,
    );
    setFetchOverrideForTests(success);
  });

  afterEach(async function () {
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await IOUtils.remove(blocker, { ignoreAbsent: true });
    await cleanupTestItems();
  });

  it("reports an error when the export folder is the only output and the write fails", async function () {
    Zotero.Prefs.set(`${PREFIX}.attachToItem`, false, true);
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(parent, "x.pdf", "application/pdf");

    const result = await convertAttachment(pdf);

    assert.strictEqual(result.status, "error");
    assert.match((result as { message: string }).message, /export folder/i);
  });

  it("succeeds with a warning when the .md was attached but the export failed", async function () {
    Zotero.Prefs.set(`${PREFIX}.attachToItem`, true, true);
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(parent, "y.pdf", "application/pdf");

    const result = await convertAttachment(pdf);

    assert.strictEqual(result.status, "ok");
    assert.match(
      (result as { warning?: string }).warning ?? "",
      /export folder/i,
    );
  });
});
