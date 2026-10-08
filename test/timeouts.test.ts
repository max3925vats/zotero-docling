import { assert } from "chai";
import { config } from "../package.json";
import {
  setFetchOverrideForTests,
  testServerConnection,
} from "../src/modules/convert";
import { withRequestTimeout } from "../src/utils/timeout";

// Audit H2: no request to docling-serve had a timeout, so a server that
// accepted the connection but never answered hung the batch forever (and
// with it every later batch). Every request now runs under a user-adjustable
// timeout.

const PREFIX = config.prefsPrefix;
const never = () => new Promise<never>(() => {});

describe("request timeouts", function () {
  describe("withRequestTimeout", function () {
    it("rejects with a clear message when the request never settles", async function () {
      let err: Error | null = null;
      try {
        await withRequestTimeout(50, () => never());
      } catch (e) {
        err = e as Error;
      }
      assert.ok(err, "must reject");
      assert.match(err!.message, /timed out after/i);
    });

    it("aborts the request's signal on timeout", async function () {
      let seen: AbortSignal | undefined;
      await withRequestTimeout(50, (signal) => {
        seen = signal;
        return never();
      }).catch(() => undefined);
      assert.isTrue(seen?.aborted, "signal must be aborted");
    });

    it("passes through a value that arrives in time", async function () {
      const v = await withRequestTimeout(1000, async () => 42);
      assert.strictEqual(v, 42);
    });

    it("passes through the request's own error", async function () {
      let err: Error | null = null;
      try {
        await withRequestTimeout(1000, async () => {
          throw new Error("refused");
        });
      } catch (e) {
        err = e as Error;
      }
      assert.strictEqual(err?.message, "refused");
    });
  });

  describe("health check against a server that never answers", function () {
    this.timeout(10000);

    afterEach(function () {
      setFetchOverrideForTests(null);
      Zotero.Prefs.clear(`${PREFIX}.healthTimeoutSec`, true);
    });

    it("gives up after healthTimeoutSec and says it timed out", async function () {
      Zotero.Prefs.set(`${PREFIX}.healthTimeoutSec`, 1, true);
      setFetchOverrideForTests((() => never()) as unknown as typeof fetch);

      const started = Date.now();
      const r = await testServerConnection("http://docling.test");

      assert.isFalse(r.ok);
      assert.match((r as { message: string }).message, /timed out/i);
      assert.isBelow(Date.now() - started, 5000);
    });
  });

  describe("timeout preference defaults", function () {
    it("ship the agreed defaults", function () {
      const expected: Record<string, number> = {
        healthTimeoutSec: 30,
        pollTimeoutSec: 30,
        asyncUploadTimeoutMin: 5,
        asyncResultTimeoutMin: 10,
        syncTimeoutMin: 10,
      };
      const actual: Record<string, unknown> = {};
      for (const key of Object.keys(expected)) {
        actual[key] = Zotero.Prefs.get(`${PREFIX}.${key}`, true);
      }
      assert.deepEqual(actual, expected);
    });
  });
});
