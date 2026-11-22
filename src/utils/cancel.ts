// Cancellation for the waits a conversion does on the client side: sleeping
// between async status polls, and the requests themselves.
//
// This never cancels anything on docling-serve, which has no cancel API (see
// README "Known limitations"). It exists so that when the plugin shuts down,
// in-flight conversions stop waiting at once instead of polling for up to
// asyncMaxWaitMin and then writing to Zotero from an unloaded plugin.
//
// A small token of our own rather than AbortController: the plugin sandbox
// and the main window are different realms, and the main window may already
// be gone at shutdown. withRequestTimeout bridges a token to the fetch's own
// AbortController.

/** Thrown (or returned) when a wait is cut short by a CancelToken. */
export class CancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CancelledError";
  }
}

export class CancelToken {
  private cancelReason: string | null = null;
  private readonly listeners = new Set<(reason: string) => void>();

  get cancelled(): boolean {
    return this.cancelReason !== null;
  }

  /** Why the token was cancelled, or null while it hasn't been. */
  get reason(): string | null {
    return this.cancelReason;
  }

  /** Cancel and notify every listener. Later calls do nothing. */
  cancel(reason: string): void {
    if (this.cancelReason !== null) return;
    this.cancelReason = reason;
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(reason);
      } catch {
        /* a listener must not stop the others */
      }
    }
    this.listeners.clear();
  }

  /**
   * Call `fn` on cancel (straight away if already cancelled). Returns a
   * function that removes the listener.
   */
  onCancel(fn: (reason: string) => void): () => void {
    if (this.cancelReason !== null) {
      fn(this.cancelReason);
      return () => {};
    }
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Sleep for `ms`; rejects with CancelledError as soon as `token` cancels. */
export function sleep(ms: number, token?: CancelToken): Promise<void> {
  return new Promise((resolve, reject) => {
    if (token?.cancelled) {
      reject(new CancelledError(token.reason ?? "Cancelled"));
      return;
    }
    const off = token?.onCancel((reason) => {
      clearTimeout(timer);
      reject(new CancelledError(reason));
    });
    const timer = setTimeout(() => {
      off?.();
      resolve();
    }, ms);
  });
}
