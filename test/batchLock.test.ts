import { assert } from "chai";
import { config } from "../package.json";
import { setFetchOverrideForTests } from "../src/modules/convert";
import { runBatch } from "../src/modules/menu";
import {
  isBatchRunning,
  releaseBatch,
  tryAcquireBatch,
} from "../src/utils/batchLock";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Audit M1–M3: the "a batch is running" flag was set/cleared in several
// places — it could stay stuck true after a throw (blocking every later
// batch), or be cleared while another batch was still running. One lock now
// serialises menu batches, auto-convert and Remove Images.

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "attachToItem",
  "useAsyncEndpoint",
  "notifyOnComplete",
];

describe("batch lock", function () {
  this.timeout(20000);

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    g.ztoolkit = g.addon.data.ztoolkit;
  });

  afterEach(async function () {
    releaseBatch();
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await cleanupTestItems();
  });

  describe("tryAcquireBatch / releaseBatch", function () {
    it("lets only one holder in at a time", function () {
      assert.isTrue(tryAcquireBatch("first"));
      assert.isTrue(isBatchRunning());
      assert.isFalse(tryAcquireBatch("second"));
      releaseBatch();
      assert.isFalse(isBatchRunning());
      assert.isTrue(tryAcquireBatch("third"));
    });
  });

  describe("runBatch", function () {
    let calls: string[];

    beforeEach(function () {
      calls = [];
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.attachToItem`, true, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, false, true);
      Zotero.Prefs.set(`${PREFIX}.notifyOnComplete`, false, true);
    });

    function stub(health: number, convert: number): typeof fetch {
      return (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: health,
          });
        }
        return new Response(JSON.stringify({ detail: "boom" }), {
          status: convert,
        });
      }) as typeof fetch;
    }

    it("refuses to start while another batch holds the lock", async function () {
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "a.pdf", "application/pdf");
      setFetchOverrideForTests(stub(200, 500));
      tryAcquireBatch("someone else");

      const ran = await runBatch([pdf], { force: false, menuLabel: "test" });

      assert.isFalse(ran);
      assert.deepEqual(calls, [], "no request may reach the server");
    });

    it("releases the lock after a batch whose conversions fail", async function () {
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "b.pdf", "application/pdf");
      setFetchOverrideForTests(stub(200, 500));

      await runBatch([pdf], { force: false, menuLabel: "test" });

      assert.isFalse(isBatchRunning());
    });

    it("releases the lock when the server is down", async function () {
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "c.pdf", "application/pdf");
      setFetchOverrideForTests(stub(503, 500));

      await runBatch([pdf], { force: false, menuLabel: "test" });

      assert.isFalse(isBatchRunning());
    });
  });
});
