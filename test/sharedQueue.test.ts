import { expect } from "chai";
import { config } from "../package.json";
import {
  convertOrSkip,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import { runBatch } from "../src/modules/menu";
import {
  isStopRequested,
  releaseBatch,
  requestStopBatch,
  tryAcquireBatch,
} from "../src/utils/batchLock";
import { conversionQueue } from "../src/utils/conversionQueue";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Menu batches and auto-convert used to exclude each other, so PDFs imported
// during a manual batch waited for the whole batch to end. They now share
// the lock and one conversion queue; Remove Images still runs alone.

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "useAsyncEndpoint",
  "maxConcurrency",
  "notifyOnComplete",
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe("shared conversion queue", function () {
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
    releaseBatch();
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await cleanupTestItems();
  });

  describe("lock sharing", function () {
    it("When a menu batch runs, then auto-convert may join but a second menu batch and Remove Images may not", function () {
      // Arrange
      tryAcquireBatch("menu");
      // Act
      const results = [
        tryAcquireBatch("auto-convert"),
        tryAcquireBatch("menu"),
        tryAcquireBatch("remove-images"),
      ];
      // Assert
      expect(results).to.deep.equal([true, false, false]);
    });

    it("When Remove Images runs, then no conversion batch may start", function () {
      // Arrange
      tryAcquireBatch("remove-images");
      // Act
      const results = [
        tryAcquireBatch("menu"),
        tryAcquireBatch("auto-convert"),
      ];
      // Assert
      expect(results).to.deep.equal([false, false]);
    });

    it("When a stop is requested, then a batch that starts afterwards is not stopped", function () {
      // Arrange
      tryAcquireBatch("menu");
      requestStopBatch();
      // Act
      tryAcquireBatch("auto-convert");
      // Assert
      expect([
        isStopRequested("menu"),
        isStopRequested("auto-convert"),
      ]).to.deep.equal([true, false]);
    });
  });

  describe("running side by side", function () {
    it("When auto-convert PDFs arrive during a menu batch, then both convert without exceeding Parallel conversions", async function () {
      // Arrange: 2 parallel conversions, each taking 150 ms.
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, false, true);
      Zotero.Prefs.set(`${PREFIX}.maxConcurrency`, 2, true);
      Zotero.Prefs.set(`${PREFIX}.notifyOnComplete`, false, true);
      let active = 0;
      let maxActive = 0;
      setFetchOverrideForTests((async (url: string) => {
        if (url.endsWith("/health")) return json({ status: "ok" });
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 150));
        active--;
        return json({
          status: "success",
          document: { md_content: "# converted" },
        });
      }) as unknown as typeof fetch);
      const parent = await makeParentItem();
      const manual = [];
      const imported = [];
      for (let i = 0; i < 4; i++) {
        manual.push(
          await makeFileAttachment(parent, `m${i}.pdf`, "application/pdf"),
        );
        imported.push(
          await makeFileAttachment(parent, `a${i}.pdf`, "application/pdf"),
        );
      }

      // Act: start the menu batch, then an auto-convert batch alongside it.
      const menuRun = runBatch(manual, { force: false, menuLabel: "Docling" });
      await new Promise((r) => setTimeout(r, 50));
      const joined = tryAcquireBatch("auto-convert");
      const autoResults = await Promise.all(
        imported.map((item) =>
          conversionQueue.run(() => convertOrSkip(item, "auto-convert")),
        ),
      );
      releaseBatch("auto-convert");
      const ran = await menuRun;

      // Assert
      expect(joined).to.equal(true);
      expect(ran).to.equal(true);
      expect(autoResults.map((r) => r.status)).to.deep.equal(
        Array(4).fill("ok"),
      );
      expect(parent.getAttachments()).to.have.lengthOf(16); // 8 PDFs + 8 .md
      expect(maxActive).to.equal(2);
    });
  });
});
