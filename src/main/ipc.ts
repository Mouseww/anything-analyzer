import { ipcMain, dialog, app, session } from "electron";
import type { LLMProviderConfig, MCPServerConfig, MCPServerSettings, MitmProxyConfig, ProxyConfig, PromptTemplate } from "@shared/types";
import type { SessionManager } from "./session/session-manager";
import type { AiAnalyzer } from "./ai/ai-analyzer";
import type { WindowManager } from "./window";
import type { Updater } from "./updater";
import type { MCPClientManager } from "./mcp/mcp-manager";
import type { MitmProxyServer } from "./proxy/mitm-proxy-server";
import type { CaManager } from "./proxy/ca-manager";
import type { ProfileStore } from './fingerprint/profile-store';
import { CertInstaller } from "./proxy/cert-installer";
import { SystemProxy } from "./proxy/system-proxy";
import { loadMitmProxyConfig, saveMitmProxyConfig } from "./proxy/mitm-proxy-config";
import {
  loadTemplates,
  saveTemplate,
  deleteTemplate,
  resetTemplate,
  findTemplate,
} from "./prompt-templates";
import {
  loadMCPServers,
  saveMCPServer,
  deleteMCPServer,
} from "./mcp/mcp-config";
import type {
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  SessionsRepo,
  ChatMessagesRepo,
  AiRequestLogRepo,
  InteractionEventsRepo,
} from "./db/repositories";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";

/**
 * Register all IPC handlers for communication between renderer and main process.
 */

/** Active analysis abort controllers, keyed by sessionId */
const analysisControllers = new Map<string, AbortController>();

/** Report IDs with in-flight chat calls — protected from cascade deletion */
const activeChatReports = new Set<string>();

export function registerIpcHandlers(deps: {
  sessionManager: SessionManager;
  aiAnalyzer: AiAnalyzer;
  windowManager: WindowManager;
  updater: Updater;
  mcpManager: MCPClientManager;
  mitmProxy: MitmProxyServer;
  caManager: CaManager;
  sessionsRepo: SessionsRepo;
  requestsRepo: RequestsRepo;
  jsHooksRepo: JsHooksRepo;
  storageSnapshotsRepo: StorageSnapshotsRepo;
  reportsRepo: AnalysisReportsRepo;
  chatMessagesRepo: ChatMessagesRepo;
  profileStore: ProfileStore;
  aiRequestLogRepo: AiRequestLogRepo;
  interactionEventsRepo: InteractionEventsRepo;
}): void {
  const {
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
  } = deps;

  // ---- Session Management ----

  ipcMain.handle(
    "session:create",
    async (_event, name: string, targetUrl: string) => {
      return sessionManager.createSession(name, targetUrl);
    },
  );

  ipcMain.handle("session:list", async () => {
    return sessionManager.listSessions();
  });

  ipcMain.handle("session:start", async (_event, sessionId: string) => {
    const tabManager = windowManager.getTabManager();
    const mainWin = windowManager.getMainWindow();
    if (!tabManager || !mainWin) throw new Error("Browser not ready");
    const proxyConfig = loadProxyConfig();
    await sessionManager.startCapture(
      sessionId,
      tabManager,
      mainWin.webContents,
      proxyConfig,
    );
  });

  ipcMain.handle("session:pause", async (_event, sessionId: string) => {
    await sessionManager.pauseCapture(sessionId);
  });

  ipcMain.handle("session:resume", async (_event, sessionId: string) => {
    await sessionManager.resumeCapture(sessionId);
  });

  ipcMain.handle("session:stop", async (_event, sessionId: string) => {
    await sessionManager.stopCapture(sessionId);
  });

  ipcMain.handle("session:delete", async (_event, sessionId: string) => {
    // Check if any reports in this session have in-flight chat calls
    const sessionReports = reportsRepo.findBySession(sessionId);
    const hasActiveChat = sessionReports.some(r => activeChatReports.has(r.id));
    if (hasActiveChat) {
      throw new Error("Cannot delete session while AI chat is in progress. Please wait for the response to complete.");
    }
    const tabManager = windowManager.getTabManager();
    await sessionManager.deleteSession(sessionId, tabManager ?? undefined);
  });

  // ---- Window Control (frameless window) ----

  ipcMain.handle("window:minimize", () => {
    windowManager.getMainWindow()?.minimize();
  });

  ipcMain.handle("window:maximize", () => {
    const win = windowManager.getMainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle("window:close", () => {
    windowManager.getMainWindow()?.close();
  });

  ipcMain.handle("window:isMaximized", () => {
    return windowManager.getMainWindow()?.isMaximized() ?? false;
  });

  // ---- Browser Control ----

  ipcMain.handle("browser:navigate", async (_event, url: string) => {
    await windowManager.navigateTo(url);
  });

  ipcMain.handle("browser:back", async () => {
    windowManager.goBack();
  });

  ipcMain.handle("browser:forward", async () => {
    windowManager.goForward();
  });

  ipcMain.handle("browser:reload", async () => {
    windowManager.reload();
  });

  ipcMain.handle("browser:clearEnv", async () => {
    const elSession = sessionManager.getActiveElectronSession() ?? session.defaultSession;
    await elSession.clearStorageData();
    await elSession.clearCache();
    windowManager.getTabManager()?.getActiveWebContents()?.reload();
  });

  ipcMain.handle("browser:setRatio", async (_event, ratio: number) => {
    windowManager.setBrowserRatio(ratio);
  });

  // Renderer reports exact browser placeholder bounds (fire-and-forget)
  ipcMain.on("browser:syncBounds", (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    windowManager.syncBrowserBounds(bounds);
  });

  ipcMain.handle("browser:setVisible", async (_event, visible: boolean) => {
    windowManager.setTargetViewVisible(visible);
  });

  ipcMain.handle("browser:toggleDevTools", async () => {
    const wc = windowManager.getTabManager()?.getActiveWebContents();
    if (!wc) return;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
    } else {
      wc.openDevTools({ mode: 'detach' });
    }
  });

  // ---- Tab Management ----

  ipcMain.handle("tabs:create", async (_event, url?: string) => {
    const tabManager = windowManager.getTabManager();
    if (!tabManager) throw new Error("Tab manager not ready");
    const tab = tabManager.createTab(url);
    return { id: tab.id, url: tab.url, title: tab.title, isActive: true };
  });

  ipcMain.handle("tabs:close", async (_event, tabId: string) => {
    const tabManager = windowManager.getTabManager();
    if (!tabManager) throw new Error("Tab manager not ready");
    tabManager.closeTab(tabId);
  });

  ipcMain.handle("tabs:activate", async (_event, tabId: string) => {
    const tabManager = windowManager.getTabManager();
    if (!tabManager) throw new Error("Tab manager not ready");
    tabManager.activateTab(tabId);
  });

  ipcMain.handle("tabs:list", async () => {
    const tabManager = windowManager.getTabManager();
    if (!tabManager) return [];
    const activeTab = tabManager.getActiveTab();
    return tabManager.getAllTabs().map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      isActive: t.id === activeTab?.id,
      isLoading: t.isLoading,
    }));
  });

  // Forward TabManager events to the renderer
  const tabManager = windowManager.getTabManager();
  const mainWin = windowManager.getMainWindow();
  if (tabManager && mainWin) {
    tabManager.on(
      "tab-created",
      (tabInfo: { id: string; url: string; title: string }) => {
        mainWin.webContents.send("tabs:created", {
          id: tabInfo.id,
          url: tabInfo.url,
          title: tabInfo.title,
          isActive: true,
        });
      },
    );
    tabManager.on("tab-closed", (data: { tabId: string }) => {
      mainWin.webContents.send("tabs:closed", data);
    });
    tabManager.on(
      "tab-activated",
      (data: { tabId: string; url: string; title: string }) => {
        mainWin.webContents.send("tabs:activated", data);
      },
    );
    tabManager.on(
      "tab-updated",
      (data: { tabId: string; url?: string; title?: string; isLoading?: boolean }) => {
        mainWin.webContents.send("tabs:updated", data);
      },
    );
  }

  // ---- Data Queries ----

  ipcMain.handle("data:requests", async (_event, sessionId: string) => {
    return requestsRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:hooks", async (_event, sessionId: string) => {
    return jsHooksRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:storage", async (_event, sessionId: string) => {
    return storageSnapshotsRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:reports", async (_event, sessionId: string) => {
    return reportsRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:clear", async (_event, sessionId: string) => {
    requestsRepo.deleteBySession(sessionId);
    jsHooksRepo.deleteBySession(sessionId);
    storageSnapshotsRepo.deleteBySession(sessionId);

    // Protect reports with in-flight chat from cascade deletion
    const allReports = reportsRepo.findBySession(sessionId);
    const protectedIds = new Set(
      allReports.filter(r => activeChatReports.has(r.id)).map(r => r.id)
    );

    if (protectedIds.size === 0) {
      reportsRepo.deleteBySession(sessionId);
    } else {
      // Delete only unprotected reports
      for (const r of allReports) {
        if (!protectedIds.has(r.id)) {
          reportsRepo.deleteById(r.id);
        }
      }
    }
  });

  // ---- AI Analysis ----

  ipcMain.handle("ai:analyze", async (_event, sessionId: string, purpose?: string, selectedSeqs?: number[]) => {
    const config = loadLLMConfig();
    if (!config) throw new Error("LLM provider not configured");

    const win = windowManager.getMainWindow();
    const onProgress = win
      ? (chunk: string) => {
          win.webContents.send("ai:progress", chunk);
        }
      : undefined;

    // 连接所有启用的 MCP 服务器
    const mcpServers = loadMCPServers();
    if (mcpServers.some((s) => s.enabled)) {
      await mcpManager.connectAll(mcpServers);
    }

    // Resolve template: if purpose matches a template ID, load it
    const template = purpose ? findTemplate(purpose) : findTemplate("auto");

    // Cancel any existing analysis for this session
    analysisControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    analysisControllers.set(sessionId, controller);

    try {
      return await aiAnalyzer.analyze(sessionId, config, onProgress, purpose, template ?? undefined, selectedSeqs, controller.signal);
    } finally {
      analysisControllers.delete(sessionId);
    }
  });

  ipcMain.handle("ai:cancel", async (_event, sessionId: string) => {
    analysisControllers.get(sessionId)?.abort();
    analysisControllers.delete(sessionId);
  });

  ipcMain.handle(
    "ai:chat",
    async (
      _event,
      sessionId: string,
      reportId: string,
      history: Array<{ role: string; content: string }>,
      userMessage: string,
    ) => {
      const config = loadLLMConfig();
      if (!config) throw new Error("LLM provider not configured");

      const win = windowManager.getMainWindow();
      const onProgress = win
        ? (chunk: string) => {
            win.webContents.send("ai:progress", chunk);
          }
        : undefined;

      if (reportId) {
        activeChatReports.add(reportId);
      }

      try {
        const reply = await aiAnalyzer.chat(sessionId, config, history, userMessage, onProgress, reportId);

        // Persist user message and AI reply to database
        if (reportId) {
          chatMessagesRepo.append(reportId, 'user', userMessage);
          chatMessagesRepo.append(reportId, 'assistant', reply);
        }

        return reply;
      } finally {
        if (reportId) {
          activeChatReports.delete(reportId);
        }
      }
    },
  );

  // ---- Chat Messages Persistence ----

  ipcMain.handle("data:chatMessages", async (_event, reportId: string) => {
    return chatMessagesRepo.findByReport(reportId);
  });

  ipcMain.handle("data:saveChatMessages", async (_event, reportId: string, messages: Array<{ role: string; content: string }>) => {
    try {
      chatMessagesRepo.insertMany(reportId, messages);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('FOREIGN KEY constraint failed')) {
        console.warn(`[data:saveChatMessages] Report ${reportId} no longer exists, skipping`);
      } else {
        throw e;
      }
    }
  });

  // ---- Settings ----

  ipcMain.handle("settings:getLLM", async () => {
    return loadLLMConfig();
  });

  ipcMain.handle(
    "settings:saveLLM",
    async (_event, config: LLMProviderConfig) => {
      saveLLMConfig(config);
    },
  );

  // ---- File Export ----

  ipcMain.handle(
    "dialog:exportFile",
    async (_event, defaultName: string, content: string) => {
      const win = windowManager.getMainWindow();
      if (!win) return false;
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (canceled || !filePath) return false;
      writeFileSync(filePath, content, "utf-8");
      return true;
    },
  );

  // ---- Auto Update ----

  ipcMain.handle("app:version", () => {
    return app.getVersion();
  });

  ipcMain.handle("update:check", async () => {
    updater.checkForUpdates();
  });

  ipcMain.on("update:install", () => {
    updater.quitAndInstall();
  });

  // ---- Prompt Templates ----

  ipcMain.handle("templates:list", async () => {
    return loadTemplates();
  });

  ipcMain.handle("templates:save", async (_event, template: PromptTemplate) => {
    saveTemplate(template);
  });

  ipcMain.handle("templates:delete", async (_event, id: string) => {
    deleteTemplate(id);
  });

  ipcMain.handle("templates:reset", async (_event, id: string) => {
    resetTemplate(id);
  });

  // ---- MCP Servers ----

  ipcMain.handle("mcp:list", async () => {
    return loadMCPServers();
  });

  ipcMain.handle("mcp:save", async (_event, server: MCPServerConfig) => {
    saveMCPServer(server);
  });

  ipcMain.handle("mcp:delete", async (_event, id: string) => {
    deleteMCPServer(id);
    // 同时断开该服务器连接
    await mcpManager.disconnect(id);
  });

  // ---- Export Requests ----

  ipcMain.handle("data:exportRequests", async (_event, sessionId: string) => {
    const win = windowManager.getMainWindow();
    if (!win) return false;
    const requests = requestsRepo.findBySession(sessionId);
    if (requests.length === 0) return false;
    const sessionInfo = sessionsRepo.findById(sessionId);
    const sessionName = sessionInfo?.name || "requests";
    const timestamp = new Date().toISOString().slice(0, 10);
    const defaultName = `${sessionName}-${timestamp}.json`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || !filePath) return false;
    writeFileSync(filePath, JSON.stringify(requests, null, 2), "utf-8");
    return true;
  });

  // ---- AI Request Logs ----

  ipcMain.handle("data:aiRequestLogs", async (_event, sessionId: string) => {
    return aiRequestLogRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:aiRequestLogsAll", async (_event, limit: number, offset: number) => {
    return aiRequestLogRepo.findAll(limit, offset);
  });

  ipcMain.handle("data:aiRequestLogDetail", async (_event, id: number) => {
    return aiRequestLogRepo.findById(id);
  });

  // ---- Proxy ----

  ipcMain.handle("proxy:get", async () => {
    return loadProxyConfig();
  });

  ipcMain.handle("proxy:save", async (_event, config: ProxyConfig) => {
    saveProxyConfigFile(config);
    // Sync upstream proxy to MITM proxy first (synchronous, won't fail)
    deps.mitmProxy.setUpstreamProxy(config);
    await applyProxy(config);
    // Also apply to the active session's partition if one exists
    const activeElSession = sessionManager.getActiveElectronSession();
    if (activeElSession) {
      await applyProxy(config, activeElSession);
    }
  });

  // ---- MCP Server Config ----

  ipcMain.handle("mcp-server:getConfig", async () => {
    return loadMCPServerConfig();
  });

  ipcMain.handle("mcp-server:saveConfig", async (_event, config: MCPServerSettings) => {
    saveMCPServerConfig(config);

    const { initMCPServer, stopMCPServer, isMCPServerRunning } = await import("./mcp/mcp-server");
    if (config.enabled && !isMCPServerRunning()) {
      await initMCPServer(
        { sessionManager, aiAnalyzer, windowManager, requestsRepo, jsHooksRepo, storageSnapshotsRepo, reportsRepo, interactionEventsRepo },
        config.port,
        config.authEnabled,
        config.authToken,
      );
    } else if (!config.enabled && isMCPServerRunning()) {
      await stopMCPServer();
    }
  });

  ipcMain.handle("mcp-server:status", async () => {
    const { isMCPServerRunning } = await import("./mcp/mcp-server");
    const config = loadMCPServerConfig();
    return { running: isMCPServerRunning(), port: config.port };
  });

  // ---- MITM Proxy ----

  ipcMain.handle("mitm-proxy:getConfig", async () => {
    return loadMitmProxyConfig();
  });

  ipcMain.handle("mitm-proxy:saveConfig", async (_event, config: MitmProxyConfig) => {
    saveMitmProxyConfig(config);
    if (config.enabled && !deps.mitmProxy.isRunning()) {
      await deps.caManager.init();
      await deps.mitmProxy.start(config.port);
    } else if (!config.enabled && deps.mitmProxy.isRunning()) {
      await deps.mitmProxy.stop();
      // Also disable system proxy if it was enabled
      if (config.systemProxy) {
        await SystemProxy.disable();
        saveMitmProxyConfig({ ...config, systemProxy: false });
      }
    }
  });

  ipcMain.handle("mitm-proxy:status", async () => {
    const config = loadMitmProxyConfig();
    return {
      running: deps.mitmProxy.isRunning(),
      port: deps.mitmProxy.getPort(),
      caInitialized: deps.caManager.isInitialized(),
      caInstalled: config.caInstalled,
      caCertPath: deps.caManager.isInitialized() ? deps.caManager.getCaCertPath() : null,
      systemProxyEnabled: config.systemProxy,
    };
  });

  ipcMain.handle("mitm-proxy:installCA", async () => {
    // Ensure CA is generated before trying to install
    if (!deps.caManager.isInitialized()) {
      await deps.caManager.init();
    }
    const result = await CertInstaller.install(deps.caManager.getCaCertPath());
    if (result.success) {
      const config = loadMitmProxyConfig();
      saveMitmProxyConfig({ ...config, caInstalled: true });
    }
    return result;
  });

  ipcMain.handle("mitm-proxy:uninstallCA", async () => {
    if (!deps.caManager.isInitialized()) {
      await deps.caManager.init();
    }
    const result = await CertInstaller.uninstall(deps.caManager.getCaCertPath());
    if (result.success) {
      const config = loadMitmProxyConfig();
      saveMitmProxyConfig({ ...config, caInstalled: false });
    }
    return result;
  });

  ipcMain.handle("mitm-proxy:exportCA", async () => {
    if (!deps.caManager.isInitialized()) {
      await deps.caManager.init();
    }
    const { dialog } = await import("electron");
    const win = deps.windowManager.getMainWindow();
    if (!win) return false;
    const certPath = deps.caManager.getCaCertPath();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: "anything-analyzer-ca.crt",
      filters: [
        { name: "Certificate", extensions: ["crt", "pem"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || !filePath) return false;
    const { readFileSync, writeFileSync } = await import("fs");
    writeFileSync(filePath, readFileSync(certPath));
    return true;
  });

  ipcMain.handle("mitm-proxy:regenerateCA", async () => {
    if (deps.mitmProxy.isRunning()) await deps.mitmProxy.stop();
    await deps.caManager.regenerate();
    const config = loadMitmProxyConfig();
    saveMitmProxyConfig({ ...config, caInstalled: false });
  });

  ipcMain.handle("mitm-proxy:enableSystemProxy", async () => {
    const config = loadMitmProxyConfig();
    const result = await SystemProxy.enable(config.port);
    if (result.success) {
      saveMitmProxyConfig({ ...config, systemProxy: true });
    }
    return result;
  });

  ipcMain.handle("mitm-proxy:disableSystemProxy", async () => {
    const result = await SystemProxy.disable();
    if (result.success) {
      const config = loadMitmProxyConfig();
      saveMitmProxyConfig({ ...config, systemProxy: false });
    }
    return result;
  });

  // ---- Shell ----
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    const { shell } = await import("electron");
    await shell.openExternal(url);
  });

  // ---- Fingerprint Profile ----

  ipcMain.handle("fingerprint:get", async (_event, sessionId: string) => {
    return profileStore.get(sessionId) ?? null;
  });

  ipcMain.handle("fingerprint:update", async (_event, profileJson: string) => {
    const profile = JSON.parse(profileJson);
    profileStore.update(profile);
  });

  ipcMain.handle("fingerprint:regenerate", async (_event, sessionId: string) => {
    return profileStore.regenerate(sessionId) ?? null;
  });

  ipcMain.handle("fingerprint:enable", async (_event, sessionId: string) => {
    const tabManager = windowManager.getTabManager();
    if (!tabManager) throw new Error("Browser not ready");
    const proxyConfig = loadProxyConfig();
    await sessionManager.enableStealth(sessionId, tabManager, proxyConfig);
  });

  ipcMain.handle("fingerprint:disable", async () => {
    await sessionManager.disableStealth();
  });

  // ---- Interaction Recording ----

  ipcMain.handle("interaction:getEvents", async (_event, sessionId: string, limit?: number) => {
    return interactionEventsRepo.findBySession(sessionId, limit ?? 1000);
  });

  ipcMain.handle("interaction:getCount", async (_event, sessionId: string) => {
    return interactionEventsRepo.count(sessionId);
  });

  ipcMain.handle("interaction:clear", async (_event, sessionId: string) => {
    interactionEventsRepo.deleteBySession(sessionId);
  });
}

// ---- Config persistence helpers ----

function getConfigPath(): string {
  return join(app.getPath("userData"), "llm-config.json");
}

export function loadLLMConfig(): LLMProviderConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LLMProviderConfig;
  } catch {
    return null;
  }
}

function saveLLMConfig(config: LLMProviderConfig): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// ---- Proxy config persistence ----

function getProxyConfigPath(): string {
  return join(app.getPath("userData"), "proxy-config.json");
}

export function loadProxyConfig(): ProxyConfig | null {
  const path = getProxyConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProxyConfig;
  } catch {
    return null;
  }
}

function saveProxyConfigFile(config: ProxyConfig): void {
  writeFileSync(getProxyConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

export async function applyProxy(
  config: ProxyConfig | null,
  elSession: Electron.Session = session.defaultSession,
): Promise<void> {
  if (!config || config.type === "none") {
    await elSession.setProxy({ mode: "direct" });
    return;
  }
  const auth = config.username && config.password
    ? `${config.username}:${config.password}@`
    : "";
  const proxyRules = `${config.type}://${auth}${config.host}:${config.port}`;
  await elSession.setProxy({ proxyRules });
}

// ---- MCP Server config persistence ----

const DEFAULT_MCP_SERVER_CONFIG: MCPServerSettings = { enabled: false, port: 23816, authEnabled: true, authToken: '' };

function getMCPServerConfigPath(): string {
  return join(app.getPath("userData"), "mcp-server-config.json");
}

export function loadMCPServerConfig(): MCPServerSettings {
  const path = getMCPServerConfigPath();
  let config: MCPServerSettings;
  if (!existsSync(path)) {
    config = { ...DEFAULT_MCP_SERVER_CONFIG };
  } else {
    try {
      config = { ...DEFAULT_MCP_SERVER_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) };
    } catch {
      config = { ...DEFAULT_MCP_SERVER_CONFIG };
    }
  }
  // Auto-generate token if empty (first run or upgraded from old config)
  if (!config.authToken) {
    config.authToken = randomUUID();
    saveMCPServerConfig(config);
  }
  return config;
}

function saveMCPServerConfig(config: MCPServerSettings): void {
  writeFileSync(getMCPServerConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}
