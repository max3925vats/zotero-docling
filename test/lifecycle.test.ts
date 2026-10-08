import { assert } from "chai";
import { config } from "../package.json";
import hooks from "../src/hooks";
import { setFetchOverrideForTests } from "../src/modules/convert";
import { registerMenu, runBatch, unregisterMenu } from "../src/modules/menu";
import {
  attachFocusListeners,
  detachFocusListeners,
} from "../src/modules/windowListeners";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Audit M6/M7: window listeners stacked up on every load and were never
// removed; menus were registered once at startup, so a main window closed
// and reopened (macOS) came back without them; one throwing shutdown step
// skipped the rest; and batches kept converting after shutdown.

const MENU_CONVERT_ID = "zotero-docling-convert";

/** Put the live plugin's own UI back after a test drove the test copy. */
async function restoreLivePlugin(): Promise<void> {
  const live = (Zotero as any)[config.addonInstance];
  for (const win of Zotero.getMainWindows()) {
    // Unload first: the live copy remembers it already registered this
    // window and would otherwise skip re-adding the items we removed.
    await live.hooks.onMainWindowUnload(win);
    await live.hooks.onMainWindowLoad(win);
  }
}

describe("lifecycle", function () {
  this.timeout(20000);

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    // A getter, not a snapshot: window loads replace addon.data.ztoolkit.
    Object.defineProperty(g, "ztoolkit", {
      configurable: true,
      get: () => g.addon.data.ztoolkit,
    });
    // Build-time constant the plugin bundle gets from esbuild `define`; the
    // test bundle doesn't, and createZToolkit() (run on window load) reads it.
    if (typeof g.__env__ === "undefined") g.__env__ = "development";
  });

  describe("focus listeners", function () {
    it("attaching twice leaves one listener, and detaching removes it", function () {
      const win = new EventTarget();
      let blurs = 0;
      const handlers = { onBlur: () => blurs++, onFocus: () => undefined };

      attachFocusListeners(win, handlers);
      attachFocusListeners(win, handlers);
      win.dispatchEvent(new Event("blur"));
      assert.strictEqual(blurs, 1, "re-attaching must not stack listeners");

      detachFocusListeners(win);
      win.dispatchEvent(new Event("blur"));
      assert.strictEqual(blurs, 1, "detached listener must not fire");
    });
  });

  describe("menus", function () {
    after(restoreLivePlugin);

    it("come back when the main window is unloaded and loaded again", async function () {
      const win = Zotero.getMainWindow();
      await hooks.onMainWindowUnload(win);
      assert.isNull(win.document.getElementById(MENU_CONVERT_ID));

      await hooks.onMainWindowLoad(win as _ZoteroTypes.MainWindow);

      assert.ok(
        win.document.getElementById(MENU_CONVERT_ID),
        "Convert menu item must be registered on window load",
      );
    });
  });

  describe("menus in more than one window", function () {
    after(restoreLivePlugin);

    it("removing them from one window leaves another window's menus alone", function () {
      const main = Zotero.getMainWindow();
      registerMenu(main);
      const other = {
        document: main.document.implementation.createHTMLDocument("other"),
      } as unknown as Window;

      unregisterMenu(other);

      assert.ok(
        main.document.getElementById(MENU_CONVERT_ID),
        "the main window's menu item must survive",
      );
    });

    it("registering twice for the same window adds each item once", function () {
      const main = Zotero.getMainWindow();
      registerMenu(main);
      registerMenu(main);
      assert.lengthOf(main.document.querySelectorAll(`#${MENU_CONVERT_ID}`), 1);
    });
  });

  describe("shutdown", function () {
    let live: any;

    beforeEach(function () {
      live = (Zotero as any)[config.addonInstance];
    });

    afterEach(async function () {
      (Zotero as any)[config.addonInstance] = live;
      live.data.alive = true;
      delete live.data.dialog;
      (globalThis as any).addon = live;
      await restoreLivePlugin();
    });

    it("finishes every step even when one of them throws", async function () {
      live.data.dialog = {
        window: {
          close() {
            throw new Error("dialog already gone");
          },
        },
      };

      let threw: unknown = null;
      try {
        await hooks.onShutdown();
      } catch (e) {
        threw = e;
      }

      assert.isNull(threw, "shutdown must not throw");
      assert.isUndefined(
        (Zotero as any)[config.addonInstance],
        "plugin instance must be unregistered",
      );
      assert.isFalse(live.data.alive);
    });
  });

  describe("batches after shutdown begins", function () {
    let calls: string[];

    afterEach(async function () {
      (globalThis as any).addon.data.alive = true;
      setFetchOverrideForTests(null);
      Zotero.Prefs.clear(`${config.prefsPrefix}.serverUrl`, true);
      await cleanupTestItems();
    });

    it("stop sending PDFs to the server", async function () {
      calls = [];
      Zotero.Prefs.set(
        `${config.prefsPrefix}.serverUrl`,
        "http://docling.test",
        true,
      );
      setFetchOverrideForTests((async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }) as typeof fetch);
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(parent, "s.pdf", "application/pdf");
      (globalThis as any).addon.data.alive = false;

      await runBatch([pdf], { force: false, menuLabel: "test" });

      assert.isEmpty(
        calls.filter((u) => u.includes("/v1/convert")),
        "no conversion request after shutdown began",
      );
    });
  });
});
