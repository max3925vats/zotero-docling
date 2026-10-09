import { assert } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  normalizeServerUrl,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import { buildAuthHeader } from "../src/modules/credentials";
import { clearAllSecrets, setSecret } from "../src/utils/secrets";
import { zipBaseName, zipUniqueName } from "../src/modules/markdownZipExport";
import {
  buildFrontmatter,
  stripExistingFrontmatter,
} from "../src/utils/frontmatter";
import { notify } from "../src/utils/notification";
import { stripImagesFromMarkdown } from "../src/utils/stripImages";
import { itemFactory } from "./_factories";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Audit M8, M11 and the Low list: smaller correctness fixes.

const PREFIX = config.prefsPrefix;
function setPref(key: string, value: unknown): void {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value as never, true);
}
function clearPrefs(keys: string[]): void {
  for (const k of keys) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
}

describe("polish", function () {
  describe("YAML frontmatter", function () {
    it("keeps a title with a newline and '---' inside one quoted value", function () {
      const fm = buildFrontmatter(
        itemFactory({ fields: { title: "Part one\n---\nPart\ttwo" } }),
      );
      const fenceLines = fm.split("\n").filter((l) => l === "---");
      assert.lengthOf(fenceLines, 2, "only the opening and closing fences");
      assert.include(fm, 'title: "Part one\\n---\\nPart\\ttwo"');
    });

    it("only treats an exact '---' line as the closing fence", function () {
      const md = "---\ntitle: x\n---x\nmore: y\n---\nbody";
      assert.strictEqual(stripExistingFrontmatter(md), "body");
    });

    it("lists authors, not editors", async function () {
      const item = new Zotero.Item("book");
      item.setField("title", "T");
      item.setCreators([
        { firstName: "Ada", lastName: "Smith", creatorType: "author" },
        { firstName: "Bob", lastName: "Jones", creatorType: "editor" },
      ]);
      const fm = buildFrontmatter(item);
      assert.include(fm, '"Smith, Ada"');
      assert.notInclude(fm, "Jones");
    });

    it("falls back to all creators when none is an author", function () {
      const item = new Zotero.Item("book");
      item.setField("title", "T");
      item.setCreators([
        { firstName: "Bob", lastName: "Jones", creatorType: "editor" },
      ]);
      assert.include(buildFrontmatter(item), '"Jones, Bob"');
    });

    it("doesn't read a citation key from the following line", function () {
      const item = itemFactory({
        fields: { extra: "Citation Key:\nOther: value" },
        key: "ABCD1234",
      });
      assert.notInclude(buildFrontmatter(item), "citation_key");
      assert.strictEqual(zipBaseName(item), "ABCD1234");
    });
  });

  describe("zip entry names", function () {
    it("treats names differing only by case as a collision", function () {
      const taken = new Set<string>();
      zipUniqueName("Smith2020", taken);
      assert.strictEqual(zipUniqueName("smith2020", taken), "smith2020.1.md");
    });
  });

  describe("stripImages", function () {
    it("keeps a longer fence open past a shorter inner fence", function () {
      const md = "````\n```\n![a](x.png)\n```\n````";
      assert.strictEqual(stripImagesFromMarkdown(md).replaced, 0);
    });
  });

  describe("credentials", function () {
    afterEach(async function () {
      clearPrefs(["authScheme", "authUsername", "authSecret"]);
      await clearAllSecrets();
    });

    it("encodes Basic auth credentials as UTF-8", async function () {
      setPref("authScheme", "basic");
      setPref("authUsername", "jürgen");
      await setSecret("docling-serve-auth", "pass€");
      const bytes = new TextEncoder().encode("jürgen:pass€");
      const expected = btoa(String.fromCharCode(...bytes));
      assert.deepEqual(buildAuthHeader(), {
        Authorization: `Basic ${expected}`,
      });
    });

    it("rejects a server URL with embedded credentials", function () {
      const r = normalizeServerUrl("http://user:secret@host:5001");
      assert.isFalse(r.ok);
      assert.match((r as { message: string }).message, /authentication/i);
    });
  });

  describe("OS notifications", function () {
    it("use showAlert when the old showAlertNotification is gone (Firefox 140)", function () {
      let shown: { title?: string; text?: string } | null = null;
      const alerts = {
        showAlert(n: { title: string; text: string }) {
          shown = { title: n.title, text: n.text };
        },
      };
      notify("Docling: done", "OK 1", alerts);
      assert.deepEqual(shown, { title: "Docling: done", text: "OK 1" });
    });
  });

  describe("async transport", function () {
    this.timeout(30000);
    const KEYS = [
      "serverUrl",
      "addFrontmatter",
      "attachToItem",
      "useAsyncEndpoint",
      "asyncPollIntervalSec",
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
      setPref("attachToItem", true);
      setPref("useAsyncEndpoint", true);
      setPref("asyncPollIntervalSec", 1);
    });

    afterEach(async function () {
      setFetchOverrideForTests(null);
      clearPrefs(KEYS);
      await cleanupTestItems();
    });

    /** Scripted async docling-serve: polls answered in order. */
    function asyncServer(polls: Array<() => Response>, submit?: Response) {
      let i = 0;
      return (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/convert/file/async")) {
          return (
            submit ??
            new Response(JSON.stringify({ task_id: "t1" }), { status: 200 })
          );
        }
        if (url.includes("/v1/status/poll/")) {
          return polls[Math.min(i++, polls.length - 1)]();
        }
        return new Response(
          JSON.stringify({
            status: "success",
            document: { md_content: "# async" },
          }),
          { status: 200 },
        );
      }) as typeof fetch;
    }

    const status = (s: string) => () =>
      new Response(JSON.stringify({ task_status: s }), { status: 200 });

    it("rides out a transient 502 from a proxy while polling", async function () {
      setFetchOverrideForTests(
        asyncServer([
          () => new Response("bad gateway", { status: 502 }),
          status("success"),
        ]),
      );
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "a.pdf", "application/pdf");

      const r = await convertAttachment(pdf);

      assert.strictEqual(r.status, "ok", JSON.stringify(r));
    });

    it("still stops on a 404 (task unknown to the server)", async function () {
      setFetchOverrideForTests(
        asyncServer([() => new Response("not found", { status: 404 })]),
      );
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "b.pdf", "application/pdf");

      const r = await convertAttachment(pdf);

      assert.strictEqual(r.status, "error");
    });

    it("shows the server's reason when the async submit is rejected", async function () {
      setFetchOverrideForTests(
        asyncServer(
          [status("success")],
          new Response(JSON.stringify({ detail: "unsupported option foo" }), {
            status: 422,
          }),
        ),
      );
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "c.pdf", "application/pdf");

      const r = await convertAttachment(pdf);

      assert.strictEqual(r.status, "error");
      assert.include(
        (r as { message: string }).message,
        "unsupported option foo",
      );
    });
  });
});
