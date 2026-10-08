// TEMPORARY (red step): a lock that never blocks, like today's split flags.
export function tryAcquireBatch(_owner: string): boolean {
  return true;
}
export function releaseBatch(): void {}
export function isBatchRunning(): boolean {
  return false;
}
