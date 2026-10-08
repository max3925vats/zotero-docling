import { assert } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  migrateUrlCredentials,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import { buildFrontmatter } from "../src/utils/frontmatter";
import { itemFactory } from "./_factories";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Review of PR 4: YAML control characters beyond ASCII, odd server error
// shapes, and users who already have credentials in their server URL.

const PREFIX = config.prefsPrefix;
const pref = (k: string) => Zotero.Prefs.get(`${PREFIX}.${k}`, true);
const setPref = (k: string, v: unknown) =>
  Zotero.Prefs.set(`${PREFIX}.${k}`, v as never, true);

describe("polish (review follow-ups)", function () {
  describe("YAML escaping", function () {
    it("escapes C1 controls, line/paragraph separators and BOM", function () {
      const title = "a\u0090b\u0085c d e﻿f";
      const fm = buildFrontmatter(itemFactory({ fields: { title } }));
      assert.include(fm, 'title: "a\\x90b\\x85c\\u2028d\\u2029e\\ufefff"');
    });

    it("escapes a lone surrogate but keeps a valid emoji", function () {
      const fm = buildFrontmatter(
        itemFactory({ fields: { title: "x\ud800y 😀" } }),
      );
      assert.include(fm, 'title: "x\\ud800y 😀"');
    });
  });

  describe("credentials in the server URL", function () {
    const KEYS = ["serverUrl", "authScheme", "authUsername", "authSecret"];
    afterEach(function () {
      for (const k of KEYS) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    });

    it("moves them into Basic auth settings once", function () {
      setPref("serverUrl", "http://ann:s%40cret@host:5001/docling");
      setPref("authScheme", "none");

      migrateUrlCredentials();

      assert.strictEqual(pref("serverUrl"), "http://host:5001/docling");
      assert.strictEqual(pref("authScheme"), "basic");
      assert.strictEqual(pref("authUsername"), "ann");
      assert.strictEqual(pref("authSecret"), "s@cret");
    });

    it("leaves an existing auth setup alone and only strips the URL", function () {
      setPref("serverUrl", "http://ann:pw@host:5001");
      setPref("authScheme", "bearer");
      setPref("authSecret", "tok");

      migrateUrlCredentials();

      assert.strictEqual(pref("serverUrl"), "http://host:5001");
      assert.strictEqual(pref("authScheme"), "bearer");
      assert.strictEqual(pref("authSecret"), "tok");
    });
  });

  describe("odd server responses", function () {
    this.timeout(30000);
    const KEYS = [
      "serverUrl",
      "addFrontmatter",
      "useAsyncEndpoint",
      "asyncPollIntervalSec",
      "asyncMaxWaitMin",
    ];

    before(function () {
      const g = globalThis as any;
      g.addon = (Zotero as any)[config.addonInstance];
      Object.defineProperty(g, "ztoolkit", {
        configurable: true,
        get: () => g.addon.data.ztoolkit,
      });
    });

    beforeEach(function () {
      setPref("serverUrl", "http://docling.test");
      setPref("addFrontmatter", false);
    });

    afterEach(async function () {
      setFetchOverrideForTests(null);
      for (const k of KEYS) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
      await cleanupTestItems();
    });

    it("reports an error whose `detail` is an object", async function () {
      setPref("useAsyncEndpoint", false);
      setFetchOverrideForTests(
        (async () =>
          new Response(JSON.stringify({ detail: { error: "proxy says no" } }), {
            status: 502,
          })) as unknown as typeof fetch,
      );
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "d.pdf", "application/pdf");

      const r = await convertAttachment(pdf);

      assert.strictEqual(r.status, "error");
      assert.include((r as { message: string }).message, "proxy says no");
    });

    it("treats a poll body of JSON null as a failed poll, not a crash", async function () {
      setPref("useAsyncEndpoint", true);
      setPref("asyncPollIntervalSec", 1);
      let polls = 0;
      setFetchOverrideForTests((async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/async")) {
          return new Response(JSON.stringify({ task_id: "t" }), {
            status: 200,
          });
        }
        if (url.includes("/poll/")) {
          polls++;
          return new Response(
            polls === 1 ? "null" : JSON.stringify({ task_status: "success" }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ status: "success", document: { md_content: "#" } }),
          { status: 200 },
        );
      }) as typeof fetch);
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "n.pdf", "application/pdf");

      const r = await convertAttachment(pdf);

      assert.strictEqual(r.status, "ok", JSON.stringify(r));
    });
  });
});
