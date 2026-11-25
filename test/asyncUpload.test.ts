import { expect } from "chai";
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

// In async mode a batch keeps more conversions in flight than the server
// runs, so uploads are capped separately (2 at a time).

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "useAsyncEndpoint",
  "asyncPollIntervalSec",
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe("async uploads", function () {
  this.timeout(30000);

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    // A getter, not a snapshot: window loads replace addon.data.ztoolkit.
    Object.defineProperty(g, "ztoolkit", {
      configurable: true,
      get: () => g.addon.data.ztoolkit,
    });
  });

  afterEach(async function () {
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await cleanupTestItems();
  });

  describe("upload cap", function () {
    it("When five conversions start at once, then at most two uploads run at a time and all five finish", async function () {
      // Arrange: each upload takes 200 ms; tasks finish at once.
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, true, true);
      Zotero.Prefs.set(`${PREFIX}.asyncPollIntervalSec`, 1, true);
      let uploading = 0;
      let maxUploading = 0;
      let next = 0;
      setFetchOverrideForTests((async (url: string) => {
        if (url.includes("/v1/convert/file/async")) {
          uploading++;
          maxUploading = Math.max(maxUploading, uploading);
          await new Promise((r) => setTimeout(r, 200));
          uploading--;
          return json({ task_id: `t${next++}`, task_status: "pending" });
        }
        if (url.includes("/v1/status/poll/")) {
          return json({ task_status: "success" });
        }
        return json({
          status: "success",
          document: { md_content: "# converted" },
        });
      }) as unknown as typeof fetch);
      const parent = await makeParentItem();
      const pdfs = [];
      for (let i = 0; i < 5; i++) {
        pdfs.push(
          await makeFileAttachment(parent, `paper${i}.pdf`, "application/pdf"),
        );
      }

      // Act
      const results = await Promise.all(pdfs.map((p) => convertAttachment(p)));

      // Assert
      expect(results.map((r) => r.status)).to.deep.equal(Array(5).fill("ok"));
      expect(maxUploading).to.equal(2);
    });
  });
});
