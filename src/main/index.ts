import { app, BrowserWindow, crashReporter } from "electron";
import { initLogger } from "./logger";
import { getDatabase, closeDatabase } from "./db/database";
import { runMigrations } from "./db/migrations";
import {
  SessionsRepo,
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  FingerprintProfilesRepo,
  ChatMessagesRepo,
  AiRequestLogRepo,
  InteractionEventsRepo,
} from "./db/repositories";
import { CaptureEngine } from "./capture/capture-engine";
import { SessionManager } from "./session/session-manager";
import { AiAnalyzer } from "./ai/ai-analyzer";
import { WindowManager } from "./window";
import { registerIpcHandlers, loadProxyConfig, applyProxy, loadMCPServerConfig } from "./ipc";
import { Updater } from "./updater";
import { MCPClientManager } from "./mcp/mcp-manager";
import { initMCPServer, stopMCPServer } from "./mcp/mcp-server";
import { CaManager } from "./proxy/ca-manager";
import { MitmProxyServer } from "./proxy/mitm-proxy-server";
import { loadMitmProxyConfig, saveMitmProxyConfig } from "./proxy/mitm-proxy-config";
import { SystemProxy } from "./proxy/system-proxy";
import { ProfileStore } from "./fingerprint/profile-store";
import { join } from "path";
import { randomUUID } from "node:crypto";

// Ignore all certificate errors (self-signed, expired, etc.)
app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch("ignore-certificate-errors-spki-list");

const windowManager = new WindowManager();

/** Pending client-certificate selections awaiting user choice. */
const pendingCertSelections = new Map<
  string,
  { certificates: Electron.Certificate[]; callback: (cert: Electron.Certificate) => void }
>();
const mcpManager = new MCPClientManager();
let sessionManagerRef: SessionManager | null = null;
let quitInProgress = false;

// Prevent unhandled promise rejections from crashing the main process.
// Common source: executeJavaScript on crashed/destroyed WebContents.
process.on("unhandledRejection", (reason) => {
  console.warn("[Main] Unhandled rejection:", reason);
});

// MITM Proxy — initialized lazily inside whenReady (app.getPath requires ready state)
let caManager: CaManager;
let mitmProxy: MitmProxyServer;

app.whenReady().then(async () => {
  // Initialize structured logging (replaces console.log/warn/error globally)
  initLogger();

  // Enable native crash reporter — dumps go to userData/Crashpad/
  crashReporter.start({ uploadToServer: false });

  // Initialize MITM CA & proxy (requires app.getPath)
  caManager = new CaManager(join(app.getPath("userData"), "mitm-ca"));
  mitmProxy = new MitmProxyServer(caManager);
  // Initialize database
  const db = getDatabase();
  runMigrations(db);

  // Initialize repositories
  const sessionsRepo = new SessionsRepo(db);
  const requestsRepo = new RequestsRepo(db);
  const jsHooksRepo = new JsHooksRepo(db);
  const storageSnapshotsRepo = new StorageSnapshotsRepo(db);
  const reportsRepo = new AnalysisReportsRepo(db);
  const chatMessagesRepo = new ChatMessagesRepo(db);
  const fingerprintRepo = new FingerprintProfilesRepo(db);
  const aiRequestLogRepo = new AiRequestLogRepo(db);
  const interactionEventsRepo = new InteractionEventsRepo(db);
  const profileStore = new ProfileStore(fingerprintRepo);

  // Initialize capture engine
  const captureEngine = new CaptureEngine(
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
  );

  // Initialize session manager
  const sessionManager = new SessionManager(sessionsRepo, captureEngine, profileStore, interactionEventsRepo);
  sessionManagerRef = sessionManager;

  // Recover from potential crash
  sessionManager.recoverFromCrash();

  // Initialize AI analyzer
  const aiAnalyzer = new AiAnalyzer(
    sessionsRepo,
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
    reportsRepo,
    aiRequestLogRepo,
  );

  // Create main window
  windowManager.createMainWindow();

  // Initialize tab manager with first tab
  windowManager.initTabs();

  // Apply proxy config from saved settings (before IPC handlers)
  const proxyConfig = loadProxyConfig();
  if (proxyConfig && proxyConfig.type !== "none") {
    applyProxy(proxyConfig).catch((err) =>
      console.error("Failed to apply proxy config:", err),
    );
  }

  // Initialize auto-updater
  const updater = new Updater();
  const mainWin = windowManager.getMainWindow();
  if (mainWin) updater.setMainWindow(mainWin);

  // Inject MCP client manager into AI analyzer
  aiAnalyzer.setMCPManager(mcpManager);

  // Register IPC handlers
  registerIpcHandlers({
    sessionManager,
    aiAnalyzer,
    windowManager,
    updater,
    mcpManager,
    mitmProxy,
    caManager,
    sessionsRepo,
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
    reportsRepo,
    chatMessagesRepo,
    profileStore,
    aiRequestLogRepo,
    interactionEventsRepo,
  });

  // Client-certificate IPC handlers
  ipcMain.handle("client-cert:select", (_event, id: string, index: number) => {
    const pending = pendingCertSelections.get(id);
    if (!pending) return;
    const cert = pending.certificates[index];
    if (cert) {
      pending.callback(cert);
    }
    pendingCertSelections.delete(id);
  });

  ipcMain.handle("client-cert:cancel", (_event, id: string) => {
    const pending = pendingCertSelections.get(id);
    if (pending) {
      // Not calling callback cancels the connection.
      pendingCertSelections.delete(id);
    }
  });

  // Check for updates on startup (non-blocking, delayed 3s)
  setTimeout(() => updater.checkForUpdates(), 3000);

  // Start MCP Server if enabled
  const mcpServerConfig = loadMCPServerConfig();
  if (mcpServerConfig.enabled) {
    initMCPServer(
      { sessionManager, aiAnalyzer, windowManager, requestsRepo, jsHooksRepo, storageSnapshotsRepo, reportsRepo, interactionEventsRepo },
      mcpServerConfig.port,
      mcpServerConfig.authEnabled,
      mcpServerConfig.authToken,
    ).catch((err) => console.error("Failed to start MCP Server:", err));
  }

  // Initialize MITM Proxy
  const mitmConfig = loadMitmProxyConfig();

  // Apply upstream proxy config to MITM proxy so outbound traffic routes correctly
  if (proxyConfig && proxyConfig.type !== "none") {
    mitmProxy.setUpstreamProxy(proxyConfig);
  }

  // Wire proxy captured events → CaptureEngine (same data shape as CDP)
  mitmProxy.on("response-captured", (data) => {
    captureEngine.handleResponseCaptured({ ...data, source: "proxy" });
  });

  if (mitmConfig.enabled) {
    caManager
      .init()
      .then(() => mitmProxy.start(mitmConfig.port))
      .then(() => {
        console.log("[Main] MITM proxy auto-started on port", mitmConfig.port);
        if (mitmConfig.systemProxy) {
          SystemProxy.enable(mitmConfig.port).catch((err) =>
            console.error("[Main] Failed to enable system proxy:", err),
          );
        }
      })
      .catch((err) => console.error("[Main] Failed to auto-start MITM proxy:", err));
  }

  // Trust ALL certificates (self-signed, expired, etc.) — required for analysis scenarios.
  // This plus the --ignore-certificate-errors switch ensures maximum compatibility.
  app.on("certificate-error", (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(true);
  });

  // Handle client-certificate selection: forward to renderer for user choice.
  app.on("select-client-certificate", (event, _webContents, url, list, callback) => {
    event.preventDefault();

    const id = randomUUID();
    pendingCertSelections.set(id, { certificates: list, callback });

    const mainWin = windowManager.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send("client-cert:select", {
        id,
        url,
        certificates: list.map((cert, index) => ({
          index,
          issuerName: cert.issuerName,
          subjectName: cert.subjectName,
          serialNumber: cert.serialNumber,
          validStart: cert.validStart,
          validExpiry: cert.validExpiry,
        })),
      });
    } else {
      // No window available — auto-select first certificate as fallback.
      if (list.length > 0) {
        callback(list[0]);
      }
      pendingCertSelections.delete(id);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createMainWindow();
      windowManager.initTabs();
      const win = windowManager.getMainWindow();
      if (win) updater.setMainWindow(win);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitInProgress) return;

  // Block immediate quit and perform ordered async cleanup first.
  event.preventDefault();
  quitInProgress = true;

  (async () => {
    try {
      // Mark shutdown state early so tab destroy handlers don't recreate tabs.
      windowManager.setShuttingDown(true);

      // 1) Stop capture pipelines first, so no new DB writes are produced.
      const currentSessionId = sessionManagerRef?.getCurrentSessionId();
      if (sessionManagerRef && currentSessionId) {
        await sessionManagerRef.stopCapture(currentSessionId);
      }

      // 2) Disable system proxy and persist state.
      await SystemProxy.disable().catch(() => {});
      const config = loadMitmProxyConfig();
      if (config.systemProxy) {
        saveMitmProxyConfig({ ...config, systemProxy: false });
      }

      // 3) Stop async services.
      await mitmProxy.stop().catch(() => {});
      await stopMCPServer().catch(() => {});
      await mcpManager.disconnectAll().catch(() => {});
    } finally {
      // 4) Close DB last, then let Electron finish normal quit flow.
      closeDatabase();
      app.quit();
    }
  })().catch(() => {
    // Ignore and still force-exit via finally block above.
  });
});
