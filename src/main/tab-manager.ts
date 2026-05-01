import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import { BrowserWindow, WebContentsView } from "electron";
import type { WebContents, Session as ElectronSession } from "electron";
import { join } from "path";

interface TabInfo {
  id: string;
  view: WebContentsView;
  url: string;
  title: string;
  isLoading: boolean;
}

/** Snapshot of a session's tab group state (kept alive while hidden). */
interface SessionTabGroup {
  tabs: Map<string, TabInfo>;
  activeTabId: string | null;
  electronSession: ElectronSession;
}

/**
 * TabManager — Manages multiple browser tabs as WebContentsView instances.
 * Each tab gets its own WebContentsView, only the active tab is displayed.
 * Popup windows (window.open) are intercepted and opened as new tabs.
 *
 * Supports per-session tab groups: each app session owns an isolated set of
 * tabs. Switching sessions hides the old group and restores (or creates) the
 * new group — WebContentsView instances stay alive so page state is preserved.
 */
export class TabManager extends EventEmitter {
  /** Tabs for the currently visible session group. */
  private tabs = new Map<string, TabInfo>();
  private activeTabId: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private boundsCalculator: (() => Electron.Rectangle) | null = null;
  private visibilityChecker: (() => boolean) | null = null;
  /** Track destroyed tabs to avoid double-close */
  private destroyedTabs = new Set<string>();
  /** True when app is quitting: no tab recreation/new tabs allowed */
  private isShuttingDown = false;
  /** Electron session for the active app session (partition isolation) */
  private activeElectronSession: ElectronSession | null = null;

  // ---- Per-session tab groups ----
  /** Stored tab groups for sessions that are not currently visible. */
  private sessionGroups = new Map<string, SessionTabGroup>();
  /** The session group ID currently driving `this.tabs`. */
  private currentGroupId: string | null = null;

  /**
   * Initialize with the main window and a bounds calculator callback.
   */
  init(
    mainWindow: BrowserWindow,
    boundsCalculator: () => Electron.Rectangle,
    visibilityChecker?: () => boolean,
  ): void {
    this.mainWindow = mainWindow;
    this.boundsCalculator = boundsCalculator;
    this.visibilityChecker = visibilityChecker ?? null;
  }

  /**
   * Switch the visible tab group to a different session.
   * - Hides (but keeps alive) the current session's tabs.
   * - Restores a previously stored group, or creates a blank tab if first visit.
   * - Emits tab events so the renderer UI stays in sync.
   *
   * Returns true if a new blank tab was created (caller may want to navigate).
   */
  switchSessionGroup(groupId: string, elSession: ElectronSession): boolean {
    if (this.currentGroupId === groupId) return false;

    // 1. Stash current group ---------------------------------------------------
    if (this.currentGroupId !== null) {
      // Remove active tab view from the window
      this.hideActiveView();

      this.sessionGroups.set(this.currentGroupId, {
        tabs: this.tabs,
        activeTabId: this.activeTabId,
        electronSession: this.activeElectronSession!,
      });

      // Tell renderer to clear its tab list (emit close for every visible tab)
      for (const [, tab] of this.tabs) {
        this.emit("tab-closed", { tabId: tab.id });
      }
    } else if (this.tabs.size > 0) {
      // First-ever switch: there may be initial default-session tabs.
      // Stash them under a special key so they don't leak.
      this.hideActiveView();
      for (const [, tab] of this.tabs) {
        this.emit("tab-closed", { tabId: tab.id });
      }
      // Destroy default-session tabs — they can't be reused in a partition
      for (const [tabId, tab] of this.tabs) {
        try { tab.view.webContents.close(); } catch { /* ignore */ }
        this.destroyedTabs.add(tabId);
      }
    }

    // Reset working state
    this.tabs = new Map();
    this.activeTabId = null;
    this.activeElectronSession = elSession;
    this.currentGroupId = groupId;

    // 2. Restore or create group -----------------------------------------------
    const existing = this.sessionGroups.get(groupId);
    let createdNew = false;

    if (existing && existing.tabs.size > 0) {
      // Restore previously stashed tabs
      this.tabs = existing.tabs;
      this.activeElectronSession = existing.electronSession;
      this.sessionGroups.delete(groupId);

      // Notify renderer about restored tabs
      for (const [, tab] of this.tabs) {
        this.emit("tab-created", { id: tab.id, url: tab.url, title: tab.title });
      }

      // Activate the tab that was active before
      const restoreId =
        existing.activeTabId && this.tabs.has(existing.activeTabId)
          ? existing.activeTabId
          : this.tabs.keys().next().value;
      if (restoreId) {
        this.activateTab(restoreId);
      }
    } else {
      // First visit to this session — create a blank tab
      this.sessionGroups.delete(groupId); // remove stale empty entry if any
      this.createTab();
      createdNew = true;
    }

    return createdNew;
  }

  /**
   * Destroy all tabs belonging to a specific session group.
   * Used when deleting a session.
   */
  destroySessionGroup(groupId: string): void {
    // If it's the current group, clear visible tabs
    if (this.currentGroupId === groupId) {
      this.destroyAllTabs();
      this.currentGroupId = null;
      return;
    }
    // Otherwise destroy the stashed group
    const group = this.sessionGroups.get(groupId);
    if (group) {
      for (const [tabId, tab] of group.tabs) {
        try { tab.view.webContents.close(); } catch { /* ignore */ }
        this.destroyedTabs.add(tabId);
      }
      this.sessionGroups.delete(groupId);
    }
  }

  /**
   * Create a new tab. Optionally navigate to a URL.
   * The new tab becomes the active tab.
   */
  createTab(url?: string): TabInfo {
    if (!this.mainWindow) throw new Error("TabManager not initialized");

    const id = uuidv4();
    const view = new WebContentsView({
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "../preload/target-preload.js"),
        ...(this.activeElectronSession
          ? { session: this.activeElectronSession }
          : {}),
      },
    });

    // Set dark background to avoid white flash while loading
    view.setBackgroundColor("#1a1a2e");

    const tab: TabInfo = { id, view, url: url || "", title: "New Tab", isLoading: false };
    this.tabs.set(id, tab);
    this.setupTabListeners(tab);
    this.activateTab(id);

    if (url) {
      view.webContents.loadURL(url).catch(() => {
        // Navigation might fail for invalid URLs
      });
    }

    this.emit("tab-created", { id: tab.id, url: tab.url, title: tab.title });
    return tab;
  }

  /**
   * Close a tab. If closing the last tab, create a new blank tab first.
   */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const isLastTab = this.tabs.size <= 1;

    // If this is the last tab, create a replacement before closing
    if (isLastTab) {
      this.createTab();
    }

    // Remove from display
    if (this.mainWindow) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {
        /* already removed */
      }
    }

    // If closing the active tab, activate another one
    if (this.activeTabId === tabId) {
      const tabIds = Array.from(this.tabs.keys());
      const idx = tabIds.indexOf(tabId);
      const nextId = tabIds[idx + 1] || tabIds[idx - 1];
      if (nextId) {
        this.activateTab(nextId);
      }
    }

    this.tabs.delete(tabId);
    this.destroyedTabs.add(tabId);

    // Destroy the WebContentsView
    try {
      tab.view.webContents.close();
    } catch {
      /* already destroyed */
    }

    this.emit("tab-closed", { tabId });
  }

  /**
   * Switch the active tab. Removes the old tab's view and shows the new one.
   */
  activateTab(tabId: string): void {
    if (!this.mainWindow) return;
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // Remove the current active tab's view
    if (this.activeTabId && this.activeTabId !== tabId) {
      const oldTab = this.tabs.get(this.activeTabId);
      if (oldTab) {
        try {
          this.mainWindow.contentView.removeChildView(oldTab.view);
        } catch {
          /* not in view */
        }
      }
    }

    // Add the new tab's view only if browser is meant to be visible
    const shouldShow = this.visibilityChecker ? this.visibilityChecker() : true;
    if (shouldShow) {
      this.mainWindow.contentView.addChildView(tab.view);
    }
    this.activeTabId = tabId;

    // Apply bounds
    if (this.boundsCalculator) {
      tab.view.setBounds(this.boundsCalculator());
    }

    this.emit("tab-activated", { tabId, url: tab.url, title: tab.title });
  }

  /**
   * Update bounds on the active tab (e.g., on window resize).
   */
  updateBounds(): void {
    if (!this.activeTabId || !this.boundsCalculator) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab) {
      tab.view.setBounds(this.boundsCalculator());
    }
  }

  getActiveTab(): TabInfo | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) || null;
  }

  getActiveWebContents(): WebContents | null {
    return this.getActiveTab()?.view.webContents || null;
  }

  getAllTabs(): TabInfo[] {
    return Array.from(this.tabs.values());
  }

  /** Mark manager as shutting down (disables tab auto-recreation paths). */
  setShuttingDown(shuttingDown: boolean): void {
    this.isShuttingDown = shuttingDown;
  }

  /** Set the Electron session used for new tabs (partition isolation). */
  setActiveElectronSession(s: ElectronSession | null): void {
    this.activeElectronSession = s;
  }

  /** Get the current session group ID. */
  getCurrentGroupId(): string | null {
    return this.currentGroupId;
  }

  /**
   * Destroy all tabs and clean up (current visible group only).
   */
  destroyAllTabs(): void {
    for (const [tabId, tab] of this.tabs) {
      if (this.mainWindow) {
        try {
          this.mainWindow.contentView.removeChildView(tab.view);
        } catch {
          /* ignore */
        }
      }
      try {
        tab.view.webContents.close();
      } catch {
        /* ignore */
      }
      this.destroyedTabs.add(tabId);
    }
    this.tabs.clear();
    this.activeTabId = null;
  }

  /**
   * Destroy ALL tabs across ALL session groups (used on app quit).
   */
  destroyEverything(): void {
    this.destroyAllTabs();
    for (const [, group] of this.sessionGroups) {
      for (const [tabId, tab] of group.tabs) {
        try { tab.view.webContents.close(); } catch { /* ignore */ }
        this.destroyedTabs.add(tabId);
      }
    }
    this.sessionGroups.clear();
  }

  // ---- Internal helpers ----

  /** Remove the active tab's view from the window (without destroying it). */
  private hideActiveView(): void {
    if (!this.mainWindow || !this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch { /* not in view */ }
    }
  }

  /**
   * Set up event listeners on a tab's WebContents.
   */
  private setupTabListeners(tab: TabInfo): void {
    const wc = tab.view.webContents;

    // Prevent page scripts from closing the window via window.close()
    // This avoids crashes when the WebContentsView is destroyed unexpectedly.
    wc.on("will-prevent-unload", (event) => {
      // Always prevent the close — do not show the "Leave site?" dialog
      event.preventDefault();
    });

    // Track loading state
    wc.on("did-start-loading", () => {
      tab.isLoading = true;
      this.emit("tab-updated", {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        isLoading: true,
      });
    });
    wc.on("did-stop-loading", () => {
      tab.isLoading = false;
      this.emit("tab-updated", {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        isLoading: false,
      });
    });

    // Handle page load failures — show inline error instead of white screen
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return; // Ignore sub-frame failures
      if (errorCode === -3) return; // ERR_ABORTED — user navigated away, not a real error

      // Sanitize values to prevent XSS in the error page
      const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const safeDesc = esc(errorDescription || "");
      const safeUrl = esc(validatedURL || "");
      // Encode the original URL for the retry button (safe inside a JS string literal)
      const retryUrl = JSON.stringify(validatedURL || "");

      const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html><html><head><style>
          body { background: #1a1a2e; color: #a0a0b8; font-family: -apple-system, system-ui, sans-serif;
            display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .box { text-align: center; max-width: 420px; }
          h2 { color: #e0e0f0; margin-bottom: 8px; }
          code { background: #2a2a4a; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
          .url { word-break: break-all; color: #7a7a9a; font-size: 13px; margin-top: 12px; }
          button { margin-top: 16px; background: #3a3a6a; border: none; color: #e0e0f0; padding: 8px 20px;
            border-radius: 6px; cursor: pointer; font-size: 13px; }
          button:hover { background: #4a4a8a; }
        </style></head><body><div class="box">
          <h2>\u65E0\u6CD5\u52A0\u8F7D\u6B64\u9875\u9762</h2>
          <p><code>${errorCode}</code> ${safeDesc}</p>
          <p class="url">${safeUrl}</p>
          <button onclick="location.href=${retryUrl.replace(/"/g, '&quot;')}">\u91CD\u8BD5</button>
        </div></body></html>
      `)}`;
      wc.loadURL(errorPage).catch(() => {});
    });

    // Override window.close() in page context to make it a no-op
    wc.on("did-finish-load", () => {
      wc.executeJavaScript("window.close = function() {};").catch(() => {});
    });
    wc.on("did-navigate-in-page", () => {
      wc.executeJavaScript("window.close = function() {};").catch(() => {});
    });

    // Intercept window.open / target="_blank" — open as new internal tab
    wc.setWindowOpenHandler((details) => {
      // Create a new tab with the popup URL
      this.createTab(details.url);
      return { action: "deny" };
    });

    // Track URL changes
    const onNavigate = (): void => {
      tab.url = wc.getURL();
      this.emit("tab-updated", {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
      });
    };
    wc.on("did-navigate", onNavigate);
    wc.on("did-navigate-in-page", onNavigate);

    // Track title changes
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title;
      this.emit("tab-updated", {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
      });
    });

    // Handle unexpected WebContents destruction (e.g., window.close()
    // bypassed our safeguards). Clean up gracefully instead of crashing.
    wc.on("destroyed", () => {
      if (this.destroyedTabs.has(tab.id) || !this.tabs.has(tab.id)) return;

      // During app quit, WebContents are expected to be destroyed; do not recreate tabs.
      if (this.isShuttingDown) {
        this.tabs.delete(tab.id);
        this.destroyedTabs.add(tab.id);
        if (this.activeTabId === tab.id) this.activeTabId = null;
        this.emit("tab-closed", { tabId: tab.id });
        return;
      }

      // If this is the last tab, replace it with a new blank tab
      // instead of letting the app crash with no view.
      if (this.tabs.size <= 1) {
        this.tabs.delete(tab.id);
        this.destroyedTabs.add(tab.id);
        this.activeTabId = null;
        // Remove destroyed view from window
        if (this.mainWindow) {
          try {
            this.mainWindow.contentView.removeChildView(tab.view);
          } catch { /* already removed */ }
        }
        // Create a replacement tab
        this.createTab();
        this.emit("tab-closed", { tabId: tab.id });
      } else {
        this.closeTab(tab.id);
      }
    });
  }
}
