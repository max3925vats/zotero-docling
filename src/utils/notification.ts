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

/** Minimal surface of nsIAlertsService we use (old and new methods). */
interface AlertsService {
  showAlert?: (alert: unknown, listener?: unknown) => void;
  showAlertNotification?: (...args: unknown[]) => void;
}

/** Build an nsIAlertNotification, or a plain stand-in if XPCOM isn't there. */
function makeAlert(title: string, body: string): unknown {
  const Cc = (globalThis as any).Components?.classes;
  const Ci = (globalThis as any).Components?.interfaces;
  try {
    const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(
      Ci.nsIAlertNotification,
    );
    // name, imageURL, title, text — the remaining init() params are optional.
    alert.init("zotero-docling", "", title, body);
    return alert;
  } catch {
    return { name: "zotero-docling", imageURL: "", title, text: body };
  }
}

/**
 * Show a desktop notification. Silently no-ops on failure (notifications
 * are nice-to-have, not load-bearing).
 *
 * Uses `showAlert(nsIAlertNotification)`, available since well before
 * Firefox 115 (Zotero 7). The old `showAlertNotification(...)` was removed
 * from newer Firefox, so on Zotero 10 the plugin's notifications silently
 * never appeared; it's kept only as a fallback. `alerts` is injectable for
 * tests.
 */
export function notify(
  title: string,
  body: string,
  alerts?: AlertsService,
): void {
  try {
    const service =
      alerts ??
      ((globalThis as any).Components?.classes?.[
        "@mozilla.org/alerts-service;1"
      ]?.getService?.(
        (globalThis as any).Components?.interfaces?.nsIAlertsService,
      ) as AlertsService | undefined);
    if (!service) return;
    if (typeof service.showAlert === "function") {
      try {
        service.showAlert(makeAlert(title, body), null);
        return;
      } catch {
        /* fall through to the old API if this build still has it */
      }
    }
    if (typeof service.showAlertNotification === "function") {
      service.showAlertNotification(
        "", // imageUrl — left blank; OS uses default
        title,
        body,
        false, // textClickable
        "", // cookie
        null, // listener
        "zotero-docling", // name
      );
    }
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
