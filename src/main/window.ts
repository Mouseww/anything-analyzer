import { BrowserWindow } from "electron";
import { join } from "path";
import { TabManager } from "./tab-manager";

/** Tab bar height in renderer (px) */
const TAB_BAR_HEIGHT = 33; // 32px height + 1px border-bottom

/**
 * WindowManager — Creates and manages the main BrowserWindow
 * and delegates embedded browser tabs to TabManager.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private tabManager: TabManager | null = null;
  /** Browser area height ratio (0.0 ~ 1.0), default 70% */
  private browserRatio = 0.7;

  /**
   * Create the main application window.
   */
  createMainWindow(): BrowserWindow {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      title: "Anything Analyzer",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (process.env["ELECTRON_RENDERER_URL"]) {
      this.mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    } else {
      this.mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    }

    return this.mainWindow;
  }

  /**
   * Initialize the tab manager and create the first (default) tab.
   */
  initTabs(): TabManager {
    if (!this.mainWindow) throw new Error("Main window not created");

    this.tabManager = new TabManager();
    this.tabManager.init(this.mainWindow, () => this.calculateTargetBounds());

    // Create the first tab
    this.tabManager.createTab();

    // Update bounds when window resizes
    this.mainWindow.on("resize", () => {
      this.tabManager?.updateBounds();
    });

    return this.tabManager;
  }

  /**
   * Navigate the active tab to a URL.
   */
  async navigateTo(url: string): Promise<void> {
    const wc = this.tabManager?.getActiveWebContents();
    if (!wc) return;
    let normalizedUrl = url;
    if (!/^https?:\/\//i.test(url)) {
      normalizedUrl = `https://${url}`;
    }
    await wc.loadURL(normalizedUrl);
  }

  /**
   * Go back in the active tab.
   */
  goBack(): void {
    const wc = this.tabManager?.getActiveWebContents();
    if (wc?.canGoBack()) wc.goBack();
  }

  /**
   * Go forward in the active tab.
   */
  goForward(): void {
    const wc = this.tabManager?.getActiveWebContents();
    if (wc?.canGoForward()) wc.goForward();
  }

  /**
   * Reload the active tab.
   */
  reload(): void {
    this.tabManager?.getActiveWebContents()?.reload();
  }

  /**
   * Get the main window instance.
   */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /**
   * Get the TabManager instance.
   */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }

  /**
   * Get the active tab's WebContents (for backward compatibility).
   */
  getTargetWebContents() {
    return this.tabManager?.getActiveWebContents() || null;
  }

  /**
   * Show or hide the active tab's browser view.
   */
  setTargetViewVisible(visible: boolean): void {
    if (!this.mainWindow || !this.tabManager) return;
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return;

    if (visible) {
      this.mainWindow.contentView.addChildView(activeTab.view);
      this.tabManager.updateBounds();
    } else {
      this.mainWindow.contentView.removeChildView(activeTab.view);
    }
  }

  /**
   * Calculate bounds for the target browser view area.
   * Layout: left sidebar (220px) + tab bar (32px) + browser panel (40px) = 72px top offset.
   */
  private calculateTargetBounds(): Electron.Rectangle {
    if (!this.mainWindow) return { x: 0, y: 0, width: 0, height: 0 };

    const contentBounds = this.mainWindow.getContentBounds();
    const width = contentBounds.width;
    const height = contentBounds.height;
    const sidebarWidth = 221; // 220px sidebar + 1px border-right
    // Renderer fixed-height elements (must match actual rendered sizes):
    const browserPanelHeight = 49; // padding 8+8 + Input 32 + borderBottom 1
    const topOffset = browserPanelHeight + TAB_BAR_HEIGHT; // 49 + 33 = 82
    const dragHandleHeight = 6;
    const controlBarHeight = 49; // padding 8+8 + Button 32 + borderBottom 1
    // Available flex space matches renderer's flex-grow split
    const availableFlexSpace = height - topOffset - dragHandleHeight - controlBarHeight;
    const browserHeight = Math.floor(Math.max(0, availableFlexSpace) * this.browserRatio);

    return {
      x: sidebarWidth,
      y: topOffset,
      width: width - sidebarWidth,
      height: browserHeight,
    };
  }

  /**
   * Set the browser area height ratio and update bounds.
   * @param ratio 0.0 ~ 1.0
   */
  setBrowserRatio(ratio: number): void {
    this.browserRatio = Math.max(0.15, Math.min(0.85, ratio));
    // Don't call updateBounds here — the renderer will report exact bounds
    // via syncBrowserBounds after its layout updates.
  }

  /**
   * Set exact bounds for the active browser tab view.
   * Called by the renderer which measures the actual placeholder position.
   */
  syncBrowserBounds(bounds: Electron.Rectangle): void {
    const tab = this.tabManager?.getActiveTab();
    if (tab) {
      tab.view.setBounds(bounds);
    }
  }

  /**
   * Get current browser area height ratio.
   */
  getBrowserRatio(): number {
    return this.browserRatio;
  }

  /**
   * Destroy all tabs and clean up.
   */
  destroyTargetView(): void {
    this.tabManager?.destroyAllTabs();
    this.tabManager = null;
  }
}
