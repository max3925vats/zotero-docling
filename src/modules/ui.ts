// Thin wrappers around Zotero's native ProgressWindow.
// All UI text passes through here so we can swap to localised strings later.
//
// Two flavours:
//   - showProgress / finishProgress / toast  — simple one-shot windows
//   - startManagedProgress / updateManagedHeadline / finishManagedProgress
//     — long-lived progress that hides on Zotero blur and re-appears on
//     focus with the current state. Used by the batch orchestrators.

export type ProgressHandle = ReturnType<typeof showProgress>;

const CLOSE_MS_SUCCESS = 3000;
const CLOSE_MS_ERROR = 8000; // errors linger so the user can read them

export function showProgress(headline: string, body?: string) {
  // closeOnClick:true so the user can dismiss manually if our auto-close lags.
  const pw = new Zotero.ProgressWindow({ closeOnClick: true });
  pw.changeHeadline(headline);
  if (body) pw.addDescription(body);
  pw.show();
  return pw;
}

export function finishProgress(
  pw: ProgressHandle,
  success: boolean,
  headline: string,
  body?: string,
) {
  pw.changeHeadline(headline);
  if (body) pw.addDescription(body);
  scheduleClose(pw, success);
}

/**
 * Standalone toast for fire-and-forget messages.
 * Description is added only once (via finishProgress), avoiding the prior
 * double-render where both showProgress and finishProgress appended it.
 */
export function toast(headline: string, body?: string, success = true) {
  const pw = showProgress(headline); // no body here — finishProgress adds it
  finishProgress(pw, success, headline, body);
  return pw;
}

/**
 * Use an explicit setTimeout + pw.close() instead of pw.startCloseTimer().
 * The built-in timer has been observed to linger on Z9; explicit close is
 * reliable. Wrapped in try/catch since close can race with manual click-close.
 */
function scheduleClose(pw: ProgressHandle, success: boolean): void {
  const ms = success ? CLOSE_MS_SUCCESS : CLOSE_MS_ERROR;
  setTimeout(() => {
    try {
      pw.close();
    } catch {
      /* already closed or window destroyed — fine */
    }
  }, ms);
}

// ---------------------------------------------------------------------------
//  Managed progress — survives blur/focus
// ---------------------------------------------------------------------------
//
// A long-running batch creates one of these. While Zotero has focus, the
// underlying ProgressWindow is visible and updated in place. When Zotero
// loses focus, the window is closed but the state is retained. When Zotero
// regains focus, the window is recreated from state.
//
// Only one managed progress is tracked at a time; starting a new one
// supersedes any previous (rare in practice — batches are serial).

interface ManagedState {
  headline: string;
  body?: string;
  /** undefined while in-flight; true/false once finishManagedProgress runs. */
  success?: boolean;
  /** null when hidden (Zotero blurred); set when visible. */
  pw: ProgressHandle | null;
}

let managed: ManagedState | null = null;

function isZoteroFocused(): boolean {
  try {
    const wins = Zotero.getMainWindows?.() ?? [];
    for (const w of wins) {
      if (w?.document?.hasFocus?.()) return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Start a managed progress. Replaces any previous in-flight one. */
export function startManagedProgress(headline: string, body?: string): void {
  if (managed?.pw) {
    try {
      managed.pw.close();
    } catch {
      /* ignore */
    }
  }
  managed = { headline, body, pw: null };
  if (isZoteroFocused()) {
    managed.pw = showProgress(headline, body);
  }
}

/**
 * Update the in-flight managed progress headline. Body is optional and
 * appended if provided. Cheap if Zotero is blurred (only updates state).
 */
export function updateManagedHeadline(headline: string, body?: string): void {
  if (!managed) return;
  managed.headline = headline;
  if (body !== undefined) managed.body = body;
  if (managed.pw) {
    try {
      managed.pw.changeHeadline(headline);
      if (body) managed.pw.addDescription(body);
    } catch {
      /* progress window already closed */
    }
  }
}

/**
 * Transition the managed progress to a finished state. Updates the headline
 * and auto-dismisses. If Zotero is currently blurred, the state is retained
 * so onZoteroFocus() can re-show the finished result on next focus.
 */
export function finishManagedProgress(
  success: boolean,
  headline: string,
  body?: string,
): void {
  if (!managed) return;
  managed.headline = headline;
  managed.body = body;
  managed.success = success;
  if (managed.pw) {
    finishProgress(managed.pw, success, headline, body);
    // Drop our tracking shortly after the auto-close fires so a focus event
    // that arrives later doesn't re-show a stale completion.
    const captured = managed;
    setTimeout(
      () => {
        if (managed === captured) managed = null;
      },
      (success ? CLOSE_MS_SUCCESS : CLOSE_MS_ERROR) + 500,
    );
  }
  // If pw is null (Zotero blurred), keep state — onZoteroFocus will re-show.
}

/** Hide the visible window but keep the state. Called from a blur listener. */
export function onZoteroBlur(): void {
  if (!managed?.pw) return;
  try {
    managed.pw.close();
  } catch {
    /* ignore */
  }
  managed.pw = null;
}

/** Re-show the managed progress with current state. Called from focus. */
export function onZoteroFocus(): void {
  if (!managed) return;
  if (managed.pw) return; // already visible
  if (managed.success === undefined) {
    // Still in-flight — show as in-progress with current headline.
    managed.pw = showProgress(managed.headline, managed.body);
  } else {
    // Already finished — show the completion message and auto-dismiss it
    // again so the user sees the result on return.
    managed.pw = showProgress(managed.headline);
    finishProgress(managed.pw, managed.success, managed.headline, managed.body);
    const captured = managed;
    setTimeout(
      () => {
        if (managed === captured) managed = null;
      },
      (managed.success ? CLOSE_MS_SUCCESS : CLOSE_MS_ERROR) + 500,
    );
  }
}
