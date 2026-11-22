import { expect } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  pollAfterMs,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Async status checks used to wait a full poll interval (5 s) every time,
// so a PDF that converted in a second still took at least 5 s to come back.

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "useAsyncEndpoint",
  "asyncPollIntervalSec",
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe("async status polling", function () {
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

  describe("pollAfterMs", function () {
    it("When the gap is below the interval, then it doubles", function () {
      // Arrange
      const last = 1000;
      // Act
      const next = pollAfterMs(last, 5000);
      // Assert
      expect(next).to.equal(2000);
    });

    it("When doubling would pass the interval, then it stops at the interval", function () {
      // Arrange
      const last = 4000;
      // Act
      const next = pollAfterMs(last, 5000);
      // Assert
      expect(next).to.equal(5000);
    });
  });

  describe("a short conversion", function () {
    it("When the task finishes within a second, then the result comes back well before one full interval", async function () {
      // Arrange: a 5 s interval and a task that is done 0.5 s after submit.
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, true, true);
      Zotero.Prefs.set(`${PREFIX}.asyncPollIntervalSec`, 5, true);
      let submittedAt = 0;
      const pollUrls: string[] = [];
      setFetchOverrideForTests((async (url: string) => {
        if (url.includes("/v1/convert/file/async")) {
          submittedAt = Date.now();
          return json({ task_id: "t-short", task_status: "pending" });
        }
        if (url.includes("/v1/status/poll/")) {
          pollUrls.push(url);
          const done = Date.now() - submittedAt > 500;
          return json({
            task_id: "t-short",
            task_status: done ? "success" : "started",
          });
        }
        return json({
          status: "success",
          document: { md_content: "# converted" },
        });
      }) as unknown as typeof fetch);
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(
        parent,
        "quick.pdf",
        "application/pdf",
      );
      const started = Date.now();

      // Act
      const result = await convertAttachment(pdf);

      // Assert
      expect(result.status).to.equal("ok");
      expect(Date.now() - started).to.be.below(4000);
      expect(pollUrls[0]).to.match(/\/v1\/status\/poll\/t-short\?wait=5$/);
    });
  });
});
