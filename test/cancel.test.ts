import { expect } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import { runBatch } from "../src/modules/menu";
import { CancelledError, CancelToken, sleep } from "../src/utils/cancel";
import {
  abortBatch,
  batchAbortToken,
  isStopRequested,
  releaseBatch,
  requestStopBatch,
  tryAcquireBatch,
} from "../src/utils/batchLock";
import { withRequestTimeout } from "../src/utils/timeout";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// The async status loop and its sleep never checked for shutdown, so a
// disabled or updated plugin kept polling for up to asyncMaxWaitMin and then
// attached the result from an unloaded plugin.

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "attachToItem",
  "useAsyncEndpoint",
  "asyncPollIntervalSec",
  "maxConcurrency",
  "notifyOnComplete",
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe("cancellation", function () {
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
    releaseBatch();
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await cleanupTestItems();
  });

  describe("sleep", function () {
    it("When the token is cancelled mid-sleep, then it rejects at once with CancelledError", async function () {
      // Arrange
      const token = new CancelToken();
      const started = Date.now();
      // Act
      const pending = sleep(10_000, token);
      setTimeout(() => token.cancel("Plugin is shutting down"), 20);
      const error = await pending.then(
        () => null,
        (e) => e,
      );
      // Assert
      expect(error).to.be.instanceOf(CancelledError);
      expect(error.message).to.equal("Plugin is shutting down");
      expect(Date.now() - started).to.be.below(2000);
    });

    it("When the token is already cancelled, then it rejects without waiting", async function () {
      // Arrange
      const token = new CancelToken();
      token.cancel("Stopped");
      // Act
      const error = await sleep(10_000, token).then(
        () => null,
        (e) => e,
      );
      // Assert
      expect(error).to.be.instanceOf(CancelledError);
    });
  });

  describe("withRequestTimeout", function () {
    it("When the token is cancelled during a request, then the signal aborts and the call rejects with CancelledError", async function () {
      // Arrange
      const token = new CancelToken();
      let seen: AbortSignal | undefined;
      // Act
      const pending = withRequestTimeout(
        60_000,
        (signal) => {
          seen = signal;
          return new Promise(() => {});
        },
        undefined,
        token,
      );
      token.cancel("Plugin is shutting down");
      const error = await pending.then(
        () => null,
        (e) => e,
      );
      // Assert
      expect(error).to.be.instanceOf(CancelledError);
      expect(seen?.aborted).to.equal(true);
    });
  });

  describe("batch lock stop and abort", function () {
    it("When a stop is requested, then the batch reports it until the lock is released", function () {
      // Arrange
      tryAcquireBatch("menu");
      // Act
      const accepted = requestStopBatch();
      const during = isStopRequested();
      releaseBatch();
      const after = isStopRequested();
      // Assert
      expect([accepted, during, after]).to.deep.equal([true, true, false]);
    });

    it("When no batch is running, then a stop request is refused", function () {
      // Arrange (nothing held)
      // Act
      const accepted = requestStopBatch();
      // Assert
      expect(accepted).to.equal(false);
    });
  });

  describe("async conversion during shutdown", function () {
    it("When the batch is aborted while polling, then the conversion stops at once and attaches nothing", async function () {
      // Arrange: a server whose task never finishes.
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, true, true);
      Zotero.Prefs.set(`${PREFIX}.asyncPollIntervalSec`, 1, true);
      setFetchOverrideForTests((async (url: string) =>
        url.includes("/v1/convert/file/async")
          ? json({ task_id: "t-forever", task_status: "pending" })
          : json({
              task_id: "t-forever",
              task_status: "started",
            })) as unknown as typeof fetch);
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(
        parent,
        "slow.pdf",
        "application/pdf",
      );
      tryAcquireBatch("menu");
      const started = Date.now();
      // Act
      const pending = convertAttachment(pdf, { cancel: batchAbortToken() });
      setTimeout(() => abortBatch("Plugin is shutting down"), 1500);
      const result = await pending;
      // Assert
      expect(result).to.deep.equal({
        status: "skipped",
        reason: "Plugin is shutting down",
      });
      expect(Date.now() - started).to.be.below(5000);
      expect(parent.getAttachments()).to.have.lengthOf(1); // just the PDF
    });
  });

  describe("stop after the PDFs in progress", function () {
    it("When a stop is requested mid-batch, then PDFs not yet started are skipped and running ones finish", async function () {
      // Arrange: one conversion at a time, each taking a little while.
      Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
      Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
      Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, false, true);
      Zotero.Prefs.set(`${PREFIX}.maxConcurrency`, 1, true);
      Zotero.Prefs.set(`${PREFIX}.notifyOnComplete`, false, true);
      let converts = 0;
      setFetchOverrideForTests((async (url: string) => {
        if (url.endsWith("/health")) return json({ status: "ok" });
        converts++;
        if (converts === 1) requestStopBatch();
        await new Promise((r) => setTimeout(r, 50));
        return json({
          status: "success",
          document: { md_content: "# converted" },
          processing_time: 1,
        });
      }) as unknown as typeof fetch);
      const parent = await makeParentItem();
      const pdfs = [
        await makeFileAttachment(parent, "a.pdf", "application/pdf"),
        await makeFileAttachment(parent, "b.pdf", "application/pdf"),
        await makeFileAttachment(parent, "c.pdf", "application/pdf"),
      ];
      // Act
      await runBatch(pdfs, { force: false, menuLabel: "Docling" });
      // Assert: only the PDF already in progress was converted.
      expect(converts).to.equal(1);
      expect(parent.getAttachments()).to.have.lengthOf(4); // 3 PDFs + 1 .md
    });
  });
});
