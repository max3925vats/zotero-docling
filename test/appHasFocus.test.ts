import { assert } from "chai";
import { appHasFocus } from "../src/modules/ui";

// Issue #45: on Linux/X11, showing the progress popup blurs the main window.
// The old blur handler treated that as "user left Zotero", closed the popup,
// focus bounced back, the popup reopened, and so on — a flicker loop. The
// blur handler now only hides the popup when focus has left the application
// entirely, which Firefox reports as a null focus-manager activeWindow.
describe("appHasFocus", function () {
  it("is false when no application window is active (user switched apps)", function () {
    assert.isFalse(appHasFocus({ activeWindow: null }));
  });

  it("is true when one of Zotero's own windows is active, e.g. the progress popup", function () {
    assert.isTrue(appHasFocus({ activeWindow: {} as Window }));
  });

  it("is false when the focus manager is unavailable, preserving the old hide-on-blur behaviour", function () {
    assert.isFalse(appHasFocus(null));
  });
});
