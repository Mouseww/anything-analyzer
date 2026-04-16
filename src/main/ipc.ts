import { ipcMain, dialog, app, session } from "electron";
import type { LLMProviderConfig, MCPServerConfig, MCPServerSettings, MitmProxyConfig, ProxyConfig, PromptTemplate } from "@shared/types";
import type { SessionManager } from "./session/session-manager";
import type { AiAnalyzer } from "./ai/ai-analyzer";
import type { WindowManager } from "./window";
import type { Updater } from "./updater";
import type { MCPClientManager } from "./mcp/mcp-manager";
import type { MitmProxyServer } from "./proxy/mitm-proxy-server";
import type { CaManager } from "./proxy/ca-manager";
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
} from "./db/repositories";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Register all IPC handlers for communication between renderer and main process.
 */
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
    await sessionManager.startCapture(
      sessionId,
      tabManager,
      mainWin.webContents,
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
    await sessionManager.deleteSession(sessionId);
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
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
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
      (data: { tabId: string; url?: string; title?: string }) => {
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
    reportsRepo.deleteBySession(sessionId);
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
    return aiAnalyzer.analyze(sessionId, config, onProgress, purpose, template ?? undefined, selectedSeqs);
  });

  ipcMain.handle(
    "ai:chat",
    async (
      _event,
      sessionId: string,
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

      return aiAnalyzer.chat(sessionId, config, history, userMessage, onProgress);
    },
  );

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

  // ---- Proxy ----

  ipcMain.handle("proxy:get", async () => {
    return loadProxyConfig();
  });

  ipcMain.handle("proxy:save", async (_event, config: ProxyConfig) => {
    saveProxyConfigFile(config);
    await applyProxy(config);
  });

  // ---- MCP Server Config ----

  ipcMain.handle("mcp-server:getConfig", async () => {
    return loadMCPServerConfig();
  });

  ipcMain.handle("mcp-server:saveConfig", async (_event, config: MCPServerSettings) => {
    saveMCPServerConfig(config);
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

export async function applyProxy(config: ProxyConfig | null): Promise<void> {
  if (!config || config.type === "none") {
    await session.defaultSession.setProxy({ mode: "direct" });
    return;
  }
  const auth = config.username && config.password
    ? `${config.username}:${config.password}@`
    : "";
  const proxyRules = `${config.type}://${auth}${config.host}:${config.port}`;
  await session.defaultSession.setProxy({ proxyRules });
}

// ---- MCP Server config persistence ----

const DEFAULT_MCP_SERVER_CONFIG: MCPServerSettings = { enabled: false, port: 23816 };

function getMCPServerConfigPath(): string {
  return join(app.getPath("userData"), "mcp-server-config.json");
}

export function loadMCPServerConfig(): MCPServerSettings {
  const path = getMCPServerConfigPath();
  if (!existsSync(path)) return DEFAULT_MCP_SERVER_CONFIG;
  try {
    return { ...DEFAULT_MCP_SERVER_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    return DEFAULT_MCP_SERVER_CONFIG;
  }
}

function saveMCPServerConfig(config: MCPServerSettings): void {
  writeFileSync(getMCPServerConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}
