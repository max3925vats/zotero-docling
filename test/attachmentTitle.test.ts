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

// The .md attachment's title used to be set by a second save after the
// import; importFromFile now sets it in the same transaction.

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "useAsyncEndpoint",
  "attachToItem",
];

describe("converted attachment", function () {
  this.timeout(20000);

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

  describe("title", function () {
    it("When a PDF is converted, then the .md attachment is titled with its filename", async function () {
      // Arrange
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, false, true);
      Zotero.Prefs.set(`${PREFIX}.attachToItem`, true, true);
      setFetchOverrideForTests(
        (async () =>
          new Response(
            JSON.stringify({
              status: "success",
              document: { md_content: "# Attention Is All You Need" },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      );
      const parent = await makeParentItem("Attention Is All You Need");
      const pdf = await makeFileAttachment(
        parent,
        "vaswani2017.pdf",
        "application/pdf",
      );
      // Act
      const result = await convertAttachment(pdf);
      // Assert
      expect(result.status).to.equal("ok");
      const md = Zotero.Items.get(
        (result as { attachmentID: number }).attachmentID,
      ) as Zotero.Item;
      expect(md.getField("title")).to.equal("vaswani2017.md");
      expect(md.attachmentFilename).to.equal("vaswani2017.md");
    });
  });
});
