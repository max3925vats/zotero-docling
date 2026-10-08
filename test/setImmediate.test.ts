import { assert } from "chai";
import { installSetImmediate } from "../src/utils/setImmediate";

// Issue #56: the plugin runs inside the loadSubScript ctx from bootstrap.js,
// which has no setImmediate (Firefox never shipped one) and no
// window/self/global for JSZip's bundled polyfill to attach to. JSZip's
// utils.delay calls a bare `setImmediate`, so every zip export threw
// ReferenceError. These tests pin the shim the plugin installs on its own
// scope at startup.
describe("installSetImmediate", function () {
  it("adds a setImmediate function to a scope that lacks one", function () {
    const scope: Record<string, unknown> = {};
    installSetImmediate(scope);
    assert.isFunction(scope.setImmediate);
  });

  it("runs the callback asynchronously with the given arguments", async function () {
    const scope: Record<string, unknown> = {};
    installSetImmediate(scope);
    const schedule = scope.setImmediate as (
      fn: (...a: unknown[]) => void,
      ...args: unknown[]
    ) => void;

    let ranSynchronously = true;
    const received = await new Promise<unknown[]>((resolve) => {
      schedule((...args: unknown[]) => resolve(args), "a", 2);
      ranSynchronously = false;
    });

    assert.isFalse(ranSynchronously, "callback must not run inline");
    assert.deepEqual(received, ["a", 2]);
  });

  it("leaves an existing setImmediate untouched", function () {
    const existing = () => undefined;
    const scope: Record<string, unknown> = { setImmediate: existing };
    installSetImmediate(scope);
    assert.strictEqual(scope.setImmediate, existing);
  });
});
