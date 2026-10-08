import { assert } from "chai";
import { config } from "../package.json";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// v0.5.0: menus go through Zotero's own MenuManager (Zotero 8+) instead of
// injecting elements into each window. These tests drive the LIVE plugin
// (the real build): ask Zotero to render its item and Tools menus the way it
// does on right-click / menu open, then check our entries.

const id = (key: string) => `${config.addonRef}-${key}`;

function render(
  popupId: string,
  target: string,
  items: Zotero.Item[],
): Element {
  const win = Zotero.getMainWindow();
  const popup = win.document.getElementById(popupId)!;
  (Zotero as any).MenuManager.updateMenuPopup(popup, target, {
    // Passing an event makes Zotero run each item's onShowing (visibility).
    event: new win.Event("popupshowing"),
    getContext: () => ({
      items,
      tabType: "library",
      tabSubType: undefined,
      tabID: "zotero-pane",
    }),
    // Don't fold plugin items into a submenu on CI's small virtual screen.
    skipGrouping: true,
  });
  return popup;
}

function entry(popup: Element, key: string): XULElement | null {
  return popup.querySelector(`[data-l10n-id="${id(key)}"]`);
}

describe("menus via Zotero.MenuManager", function () {
  this.timeout(20000);

  afterEach(async function () {
    await cleanupTestItems();
  });

  it("adds Convert to the item menu for a PDF, and hides Re-convert without a .md", async function () {
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(parent, "m.pdf", "application/pdf");

    const popup = render("zotero-itemmenu", "main/library/item", [pdf]);

    const convert = entry(popup, "menuitem-convert");
    assert.ok(convert, "Convert entry must be rendered");
    assert.isFalse(convert!.hidden, "Convert must be visible for a PDF");
    assert.isTrue(
      entry(popup, "menuitem-reconvert")?.hidden ?? true,
      "Re-convert must be hidden without an existing .md",
    );
  });

  it("shows Re-convert when the PDF already has its .md", async function () {
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(parent, "r.pdf", "application/pdf");
    await makeFileAttachment(parent, "r.md", "text/markdown");

    const popup = render("zotero-itemmenu", "main/library/item", [pdf]);

    assert.isFalse(entry(popup, "menuitem-reconvert")?.hidden ?? true);
  });

  it("adds the Tools menu entries", function () {
    const popup = render("menu_ToolsPopup", "main/menubar/tools", []);
    assert.ok(entry(popup, "menuitem-tools-export-md-zip"));
    assert.ok(entry(popup, "menuitem-tools-remove-images"));
  });

  it("labels resolve to real text in the main window", async function () {
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(parent, "l.pdf", "application/pdf");
    const popup = render("zotero-itemmenu", "main/library/item", [pdf]);
    const convert = entry(popup, "menuitem-convert")!;

    await Zotero.getMainWindow().document.l10n!.translateElements([convert]);

    assert.strictEqual(convert.getAttribute("label"), "Convert with Docling");
  });

  it("no longer injects its own menu elements", function () {
    const doc = Zotero.getMainWindow().document;
    assert.isNull(doc.getElementById("zotero-docling-convert"));
  });
});
