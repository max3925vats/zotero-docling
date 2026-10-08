import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";
import { installSetImmediate } from "./utils/setImmediate";

// JSZip needs a bare `setImmediate` in our sandbox scope (issue #56).
installSetImmediate(_globalThis);

const basicTool = new BasicTool();

// Create the instance unless a live one already exists. An instance with
// alive === false was left behind by a shutdown that didn't finish; starting
// up on it would run the old bundle's code, so replace it.
// @ts-expect-error - Plugin instance is not typed
const existing = basicTool.getGlobal("Zotero")[config.addonInstance];
if (!existing || existing.data?.alive === false) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
