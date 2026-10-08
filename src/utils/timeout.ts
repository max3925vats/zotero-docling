// Request timeouts (audit H2). Without them, a docling-serve that accepts the
// connection but never answers hung a batch forever — and because the batch
// never finished, every later batch was refused until Zotero restarted.

/** Thrown when a request exceeds its timeout. */
export class RequestTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Timed out after ${formatTimeout(ms)}`);
    this.name = "RequestTimeoutError";
  }
}

/** "30 s", "10 min", "0.05 s" — matches how the prefs pane labels units. */
export function formatTimeout(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}

/**
 * Run `run` (a fetch plus reading its body) under a timeout of `ms`.
 *
 * The signal is aborted on timeout so the underlying fetch is cancelled, but
 * we don't rely on that alone: the race rejects even if the request ignores
 * the signal. Pass the AbortController constructor from the same realm as
 * the fetch being used (the plugin sandbox and the main window are different
 * realms); it defaults to this realm's.
 */
export async function withRequestTimeout<T>(
  ms: number,
  run: (signal?: AbortSignal) => Promise<T>,
  AbortCtor: typeof AbortController | undefined = (globalThis as any)
    .AbortController,
): Promise<T> {
  const controller = AbortCtor ? new AbortCtor() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new RequestTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller?.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
