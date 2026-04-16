import { v4 as uuidv4 } from "uuid";
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import type { Session } from "@shared/types";
import type { SessionsRepo } from "../db/repositories";
import type { TabManager } from "../tab-manager";
import { CdpManager } from "../cdp/cdp-manager";
import { CaptureEngine } from "../capture/capture-engine";
import { JsInjector } from "../capture/js-injector";
import { StorageCollector } from "../capture/storage-collector";

/** Per-tab capture bundle: CDP + JS hooks + storage */
interface TabCaptureBundle {
  cdp: CdpManager;
  injector: JsInjector;
  storage: StorageCollector;
}

/**
 * SessionManager — Manages the lifecycle of capture sessions.
 * Coordinates per-tab CDP, JS injection, storage collection, and capture engine.
 */
export class SessionManager {
  private currentSessionId: string | null = null;
  private tabManager: TabManager | null = null;
  private tabCaptures = new Map<string, TabCaptureBundle>();

  /** Global hook IPC handler (registered once per session) */
  private hookIpcHandler:
    | ((event: Electron.IpcMainEvent, data: unknown) => void)
    | null = null;
  /** TabManager event listeners */
  private tabCreatedHandler:
    | ((tabInfo: { id: string; url: string; title: string }) => void)
    | null = null;
  private tabClosedHandler: ((data: { tabId: string }) => void) | null = null;

  constructor(
    private sessionsRepo: SessionsRepo,
    private captureEngine: CaptureEngine,
  ) {}

  /**
   * Create a new session record.
   */
  createSession(name: string, targetUrl: string): Session {
    const session: Session = {
      id: uuidv4(),
      name,
      target_url: targetUrl,
      status: "stopped",
      created_at: Date.now(),
      stopped_at: null,
    };
    this.sessionsRepo.insert(session);
    return session;
  }

  /**
   * Start capturing on a session. Attaches capture pipelines to all existing tabs
   * and auto-attaches to new tabs created during the session.
   */
  async startCapture(
    sessionId: string,
    tabManager: TabManager,
    rendererWebContents: WebContents,
  ): Promise<void> {
    const session = this.sessionsRepo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Stop any running capture first
    if (this.currentSessionId) {
      await this.stopCapture(this.currentSessionId);
    }

    this.currentSessionId = sessionId;
    this.tabManager = tabManager;

    // Start capture engine
    this.captureEngine.start(sessionId, rendererWebContents);

    // Register global hook IPC listener (once for all tabs)
    this.hookIpcHandler = (_event, data) => {
      const hookData = data as {
        type: string;
        hookType: string;
        functionName: string;
        arguments: string;
        result: string | null;
        callStack: string | null;
        timestamp: number;
      };
      if (hookData.type === "ar-hook") {
        this.captureEngine.handleHookCaptured({
          hookType: hookData.hookType,
          functionName: hookData.functionName,
          arguments: hookData.arguments,
          result: hookData.result,
          callStack: hookData.callStack,
          timestamp: hookData.timestamp,
        });
      }
    };
    ipcMain.on("capture:hook-data", this.hookIpcHandler);

    // Attach capture pipelines to all existing tabs
    for (const tab of tabManager.getAllTabs()) {
      await this.attachCaptureToTab(tab.id, tab.view.webContents);
    }

    // Auto-attach to new tabs
    this.tabCreatedHandler = async (tabInfo) => {
      const tab = tabManager.getAllTabs().find((t) => t.id === tabInfo.id);
      if (tab) {
        await this.attachCaptureToTab(tab.id, tab.view.webContents);
      }
    };
    this.tabClosedHandler = (data) => {
      this.detachCaptureFromTab(data.tabId);
    };
    tabManager.on("tab-created", this.tabCreatedHandler);
    tabManager.on("tab-closed", this.tabClosedHandler);

    // Update session status
    this.sessionsRepo.updateStatus(sessionId, "running");
  }

  /**
   * Attach CDP, JS injector, and storage collector to a single tab.
   * If CDP attachment fails (e.g. blank page, debugger conflict), the tab is
   * silently skipped — proxy-based capture still works without CDP.
   */
  private async attachCaptureToTab(
    tabId: string,
    webContents: WebContents,
  ): Promise<void> {
    if (this.tabCaptures.has(tabId)) return;

    const cdp = new CdpManager();
    const injector = new JsInjector();
    const storage = new StorageCollector();

    // Start CDP manager — non-fatal if it fails
    try {
      await cdp.start(webContents);
    } catch (err) {
      console.warn(`[SessionManager] CDP attach failed for tab ${tabId}, skipping browser capture:`, (err as Error).message);
      cdp.detach();
      return;
    }

    cdp.on("response-captured", (data) => {
      this.captureEngine.handleResponseCaptured(data);
    });
    cdp.on("frame-navigated", () => {
      storage.triggerCollection();
    });

    // Start JS injector (injection only, no IPC listener)
    injector.start(webContents);

    // Start storage collector
    storage.start(this.currentSessionId!, webContents);
    storage.on("storage-collected", (data) => {
      this.captureEngine.handleStorageCollected(data);
    });

    this.tabCaptures.set(tabId, { cdp, injector, storage });
  }

  /**
   * Detach and clean up capture pipeline for a tab.
   */
  private detachCaptureFromTab(tabId: string): void {
    const bundle = this.tabCaptures.get(tabId);
    if (!bundle) return;

    // Stop storage FIRST — its stop() does a final collectAll() that needs the debugger alive
    bundle.storage.stop();
    bundle.injector.stop();
    bundle.cdp.stop();
    bundle.cdp.detach();
    this.tabCaptures.delete(tabId);
  }

  /**
   * Pause capturing — stops interception on all tabs but keeps session open.
   */
  async pauseCapture(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;

    for (const bundle of this.tabCaptures.values()) {
      bundle.storage.stop();
      bundle.injector.stop();
      await bundle.cdp.stop();
    }

    this.sessionsRepo.updateStatus(sessionId, "paused");
  }

  /**
   * Resume capturing after a pause — re-attaches capture pipelines to all tabs.
   */
  async resumeCapture(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;
    const session = this.sessionsRepo.findById(sessionId);
    if (!session || session.status !== "paused") return;

    // Detach stale bundles then re-attach fresh ones
    for (const tabId of Array.from(this.tabCaptures.keys())) {
      this.detachCaptureFromTab(tabId);
    }

    if (this.tabManager) {
      for (const tab of this.tabManager.getAllTabs()) {
        await this.attachCaptureToTab(tab.id, tab.view.webContents);
      }
    }

    this.sessionsRepo.updateStatus(sessionId, "running");
  }

  /**
   * Stop capturing and finalize the session.
   */
  async stopCapture(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;

    // Detach all tab capture pipelines
    for (const tabId of Array.from(this.tabCaptures.keys())) {
      this.detachCaptureFromTab(tabId);
    }

    // Remove TabManager event listeners
    if (this.tabManager) {
      if (this.tabCreatedHandler)
        this.tabManager.removeListener("tab-created", this.tabCreatedHandler);
      if (this.tabClosedHandler)
        this.tabManager.removeListener("tab-closed", this.tabClosedHandler);
    }
    this.tabCreatedHandler = null;
    this.tabClosedHandler = null;
    this.tabManager = null;

    // Remove global hook IPC listener
    if (this.hookIpcHandler) {
      ipcMain.removeListener("capture:hook-data", this.hookIpcHandler);
      this.hookIpcHandler = null;
    }

    this.captureEngine.stop();
    this.sessionsRepo.updateStatus(sessionId, "stopped", Date.now());
    this.currentSessionId = null;
  }

  /**
   * List all sessions.
   */
  listSessions(): Session[] {
    return this.sessionsRepo.findAll();
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.currentSessionId === sessionId) {
      await this.stopCapture(sessionId);
    }
    this.sessionsRepo.delete(sessionId);
  }

  /**
   * Recover from crash — mark any 'running' sessions as 'stopped'.
   */
  recoverFromCrash(): void {
    const sessions = this.sessionsRepo.findAll();
    for (const session of sessions) {
      if (session.status === "running" || session.status === "paused") {
        this.sessionsRepo.updateStatus(session.id, "stopped", Date.now());
      }
    }
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }
}
