// TEMPORARY (red step): no timeout, matching current behaviour.
export function withRequestTimeout<T>(
  _ms: number,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  return run(undefined);
}
