import { assert } from "chai";
import { asyncMaxWaitMs } from "../src/modules/transport";

// History review: the async max wait was meant to allow "no limit" (README
// on main, commit 4ba5ace), but the code always turned 0 into 240 min.
// Decision (v0.4.0): keep 240 min as the default and let 0 mean no limit.
describe("asyncMaxWaitMs", function () {
  const MIN = 60_000;

  it("defaults to 240 minutes when unset or invalid", function () {
    assert.strictEqual(asyncMaxWaitMs(undefined), 240 * MIN);
    assert.strictEqual(asyncMaxWaitMs("abc"), 240 * MIN);
    assert.strictEqual(asyncMaxWaitMs(-5), 240 * MIN);
  });

  it("treats 0 as no limit", function () {
    assert.strictEqual(asyncMaxWaitMs(0), Infinity);
  });

  it("uses the configured minutes, capped at 1440", function () {
    assert.strictEqual(asyncMaxWaitMs(30), 30 * MIN);
    assert.strictEqual(asyncMaxWaitMs(5000), 1440 * MIN);
  });
});
