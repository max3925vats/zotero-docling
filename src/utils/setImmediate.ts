// setImmediate shim for the plugin sandbox (issue #56).
//
// bootstrap.js loads the plugin bundle with
// `Services.scriptloader.loadSubScript(url, ctx)`, so bare identifiers in the
// bundle resolve against `ctx` first. Firefox/Zotero never provided a native
// setImmediate, and JSZip's bundled polyfill only attaches itself to
// `global`/`self`/`window` — none of which exist in `ctx` — so its bare
// `setImmediate(...)` call in utils.delay threw ReferenceError and every
// "Export markdown to .zip" failed. Installing the function on `ctx` (our
// `_globalThis`) at startup makes that bare lookup succeed.

type Callback = (...args: unknown[]) => void;

/**
 * Define `scope.setImmediate` if it is missing. Callbacks are queued on the
 * main-thread event loop (not as microtasks) so JSZip's chunked generation
 * still yields to the UI between chunks, which is the point of setImmediate.
 */
export function installSetImmediate(scope: Record<string, unknown>): void {
  if (typeof scope.setImmediate === "function") return;
  scope.setImmediate = (fn: Callback, ...args: unknown[]): void => {
    const run = () => fn(...args);
    const tm = (globalThis as any).Services?.tm;
    if (typeof tm?.dispatchToMainThread === "function") {
      tm.dispatchToMainThread(run);
    } else {
      setTimeout(run, 0);
    }
  };
}
