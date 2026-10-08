import { assert } from "chai";
import { config } from "../package.json";
import { getString } from "../src/utils/locale";

// UI strings moved into addon.ftl must resolve (a missing message comes back
// as its raw "zoteroDocling-…" ID) and pick the right plural form.
describe("localized UI strings", function () {
  before(function () {
    (globalThis as any).addon = (Zotero as any)[config.addonInstance];
  });

  it("resolves singular and plural forms", function () {
    const one = getString("zip-exported", {
      args: { count: 1, path: "/x.zip" },
    });
    const many = getString("zip-exported", {
      args: { count: 3, path: "/x.zip" },
    });
    assert.notInclude(one, config.addonRef);
    assert.include(one, "1 markdown file");
    assert.include(many, "markdown files");
  });

  it("resolves the strings used by dialogs and toasts", function () {
    for (const id of [
      "reconvert-confirm-title",
      "remove-images-confirm-warning",
      "zip-missing-question",
      "busy-batch",
      "toast-no-pdfs",
    ] as const) {
      const text = getString(id);
      assert.isAbove(text.length, 0);
      assert.notInclude(text, `${config.addonRef}-`, `${id} must resolve`);
    }
  });
});
