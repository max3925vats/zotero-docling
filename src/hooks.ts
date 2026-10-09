import { initLocale, getString } from "./utils/locale";
import { registerMenus, unregisterMenus } from "./modules/menu";
import { migrateUrlCredentials } from "./modules/convert";
import { registerNotifier, unregisterNotifier } from "./modules/notifier";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { onZoteroBlur, onZoteroFocus, toast } from "./modules/ui";
import {
  attachFocusListeners,
  detachFocusListeners,
} from "./modules/windowListeners";
import { createZToolkit } from "./utils/ztoolkit";
import { getPref, setPref } from "./utils/prefs";

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  safely("server URL credential migration", migrateUrlCredentials);
  registerPrefsPane();
  // Once for all windows: Zotero's MenuManager renders them per window.
  safely("menu registration", registerMenus);
  registerNotifier();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
  maybeShowFirstRunNudge();
}

/**
 * Surface a one-time toast pointing the user at the preferences pane.
 * Fires only on the first startup after install (gated on the
 * `firstRunCompleted` pref). The flag is also flipped by a successful
 * Test Connection in the prefs pane, so a user who finds prefs without
 * the toast still won't see it next time.
 *
 * Deferred via setTimeout so the toast doesn't compete with Zotero's
 * own startup UI noise.
 */
function maybeShowFirstRunNudge(): void {
  try {
    if ((getPref("firstRunCompleted") ?? false) as boolean) return;
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      toast(
        "zotero-docling installed",
        "Open Tools → Settings → zotero-docling to verify your server connection.",
        true,
      );
      setPref("firstRunCompleted", true);
    } catch (e) {
      Zotero.debug(
        `[zotero-docling] first-run nudge failed (non-fatal): ${(e as Error).message}`,
      );
    }
  }, 2500);
}

/** Run one lifecycle step; a failure is logged and never stops the rest. */
function safely(label: string, step: () => void): void {
  try {
    step();
  } catch (e) {
    Zotero.debug(
      `[zotero-docling] ${label} failed (non-fatal): ${(e as Error).message}`,
    );
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Fresh ztoolkit per window — the toolkit owns DOM lifetime.
  addon.data.ztoolkit = createZToolkit();
  // (Template had insertFTLIfNeeded("...-mainWindow.ftl") here; we don't ship
  // a mainWindow.ftl, so omitting it avoids "Missing resource" log spam.)

  // MenuManager menu labels are resolved by the window's own Fluent
  // localization, so menus.ftl must be loaded into every main window. It's a
  // separate file (not addon.ftl) because a version switch without a restart
  // can serve the previous version's cached addon.ftl.
  safely("menu strings", () =>
    (win as any).MozXULElement.insertFTLIfNeeded(
      `${addon.data.config.addonRef}-menus.ftl`,
    ),
  );

  // Blur/focus listeners drive the managed-progress hide-on-blur behaviour
  // (the "stop showing the toast when user switches apps" UX). Re-show on
  // focus brings the latest state back. Stored so unload can remove them.
  safely("focus listeners", () =>
    attachFocusListeners(win, {
      onBlur: onZoteroBlur,
      onFocus: onZoteroFocus,
    }),
  );
}

/**
 * Tell Zotero where our preferences XHTML lives so it shows up as a pane in
 * Edit → Settings. Without this call the pane file is just an orphan asset.
 */
function registerPrefsPane(): void {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("pref-pane-label"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  safely("focus listener removal", () => detachFocusListeners(win));
  // No toolkit-wide unregisterAll() here: the toolkit is shared, so that
  // would also remove things belonging to other open windows.
  safely("dialog close", () => addon.data.dialog?.window?.close());
}

function onShutdown(): void {
  // First, so running batches stop picking up new items (menu/notifier
  // check `alive` between items).
  addon.data.alive = false;
  // Every step runs even if an earlier one throws; previously one throw
  // skipped the rest, including unregistering the instance (audit M7).
  safely("notifier removal", unregisterNotifier);
  for (const win of Zotero.getMainWindows()) {
    safely("focus listener removal", () => detachFocusListeners(win));
  }
  safely("menu removal", unregisterMenus);
  safely("toolkit cleanup", () => ztoolkit.unregisterAll());
  safely("dialog close", () => addon.data.dialog?.window?.close());
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(
  type: string,
  data: { [key: string]: any },
): Promise<void> {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  // Re-register menus (used by tests to restore the live plugin's menus
  // after exercising shutdown).
  registerMenus,
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
