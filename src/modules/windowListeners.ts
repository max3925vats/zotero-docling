// TEMPORARY (red step): today's behaviour — listeners stack, never removed.
export function attachFocusListeners(
  win: EventTarget,
  handlers: { onBlur: () => void; onFocus: () => void },
): void {
  win.addEventListener("blur", () => handlers.onBlur());
  win.addEventListener("focus", () => handlers.onFocus());
}
export function detachFocusListeners(_win: EventTarget): void {}
