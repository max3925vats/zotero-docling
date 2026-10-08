// Per-window blur/focus listeners for the managed progress popup (ui.ts).
//
// Each main window gets exactly one pair, stored so it can be removed on
// window unload and plugin shutdown. Previously anonymous listeners were
// added on every window load and never removed, so they stacked up across
// disable/enable and kept firing into a dead copy of the plugin (audit M6).

interface Handlers {
  onBlur: () => void;
  onFocus: () => void;
}

const attached = new WeakMap<
  EventTarget,
  { blur: () => void; focus: () => void }
>();

/** Attach (or re-attach, replacing any previous pair) to `win`. */
export function attachFocusListeners(
  win: EventTarget,
  handlers: Handlers,
): void {
  detachFocusListeners(win);
  const blur = () => handlers.onBlur();
  const focus = () => handlers.onFocus();
  win.addEventListener("blur", blur);
  win.addEventListener("focus", focus);
  attached.set(win, { blur, focus });
}

/** Remove the pair attached to `win`, if any. */
export function detachFocusListeners(win: EventTarget): void {
  const pair = attached.get(win);
  if (!pair) return;
  win.removeEventListener("blur", pair.blur);
  win.removeEventListener("focus", pair.focus);
  attached.delete(win);
}
