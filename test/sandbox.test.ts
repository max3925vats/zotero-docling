import { assert } from "chai";
import { config } from "../package.json";

// Sandbox fidelity. Tests run in a window realm, but the plugin itself runs
// in the bare scope bootstrap.js gives it (no window/self/global/
// setImmediate). Bugs that only exist there — like #56, JSZip needing
// setImmediate — are invisible to ordinary tests. This loads the real built
// plugin script into a scope shaped like bootstrap's and checks the
// sandbox-specific setup is in place.

async function pluginScriptURL(): Promise<string> {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  ) as any;
  const addon = await AddonManager.getAddonByID(config.addonID);
  return addon.getResourceURI(`content/scripts/${config.addonRef}.js`).spec;
}

describe("plugin sandbox", function () {
  it("gets a working setImmediate in a bootstrap-shaped scope", async function () {
    const url = await pluginScriptURL();
    // Same shape as bootstrap.js: ctx = { rootURI }, ctx._globalThis = ctx.
    const ctx: Record<string, unknown> = {
      rootURI: url.replace(/content\/scripts\/[^/]+$/, ""),
    };
    ctx._globalThis = ctx;

    Services.scriptloader.loadSubScript(url, ctx);

    assert.isFunction(ctx.setImmediate, "setImmediate must be installed");
    const ran = await new Promise<boolean>((resolve) => {
      (ctx.setImmediate as (fn: () => void) => void)(() => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    assert.isTrue(ran, "setImmediate callbacks must run");
  });
});
