// Optional OS-level notification when a batch completes.
// Pref-gated via `notifyOnComplete`; additionally suppressed when Zotero
// itself is the focused application (user is already watching).
//
// Uses Mozilla's nsIAlertsService, which Zotero already exposes — works
// cross-platform (macOS Notification Center, Windows toast, Linux libnotify).

/** True if any Zotero main window currently has OS focus. */
function isZoteroFocused(): boolean {
  try {
    const wins = Zotero.getMainWindows?.() ?? [];
    for (const w of wins) {
      // `document.hasFocus()` is the most reliable cross-platform check.
      if (w?.document?.hasFocus?.()) return true;
    }
  } catch {
    /* fall through to false */
  }
  return false;
}

/**
 * Show a desktop notification. Silently no-ops on failure (notifications
 * are nice-to-have, not load-bearing).
 */
export function notify(title: string, body: string): void {
  try {
    const Cc = (globalThis as any).Components?.classes;
    const Ci = (globalThis as any).Components?.interfaces;
    if (!Cc || !Ci) return;
    const alerts = Cc["@mozilla.org/alerts-service;1"]?.getService?.(
      Ci.nsIAlertsService,
    );
    if (!alerts?.showAlertNotification) return;
    alerts.showAlertNotification(
      "", // imageUrl — left blank; OS uses default
      title,
      body,
      false, // textClickable
      "", // cookie
      null, // listener
      "zotero-docling", // name
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Notify only when (a) notifyOnComplete pref is on AND (b) Zotero is not
 * the focused application. Centralises the policy used by orchestrators.
 */
export function notifyOnBatchComplete(
  enabled: boolean,
  title: string,
  body: string,
): void {
  if (!enabled) return;
  if (isZoteroFocused()) return;
  notify(title, body);
}
