import { contextBridge, ipcRenderer } from "electron";

// Forward JS hook messages from the target page context to the main process.
// The hook script (injected via executeJavaScript) uses window.postMessage
// to send captured data; we relay it over IPC.
window.addEventListener("message", (event) => {
  if (event.data?.type === "ar-hook") {
    ipcRenderer.send("capture:hook-data", event.data);
  }
});

// Expose IPC APIs to renderer
contextBridge.exposeInMainWorld("electronAPI", {
  // Session management
  createSession: (name: string, targetUrl: string) =>
    ipcRenderer.invoke("session:create", name, targetUrl),
  listSessions: () => ipcRenderer.invoke("session:list"),
  startCapture: (sessionId: string) =>
    ipcRenderer.invoke("session:start", sessionId),
  pauseCapture: (sessionId: string) =>
    ipcRenderer.invoke("session:pause", sessionId),
  resumeCapture: (sessionId: string) =>
    ipcRenderer.invoke("session:resume", sessionId),
  stopCapture: (sessionId: string) =>
    ipcRenderer.invoke("session:stop", sessionId),
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke("session:delete", sessionId),

  // Browser control
  navigate: (url: string) => ipcRenderer.invoke("browser:navigate", url),
  goBack: () => ipcRenderer.invoke("browser:back"),
  goForward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  setBrowserRatio: (ratio: number) =>
    ipcRenderer.invoke("browser:setRatio", ratio),
  setTargetViewVisible: (visible: boolean) =>
    ipcRenderer.invoke("browser:setVisible", visible),
  exportFile: (defaultName: string, content: string) =>
    ipcRenderer.invoke("dialog:exportFile", defaultName, content),

  // Tab management
  createTab: (url?: string) => ipcRenderer.invoke("tabs:create", url),
  closeTab: (tabId: string) => ipcRenderer.invoke("tabs:close", tabId),
  activateTab: (tabId: string) => ipcRenderer.invoke("tabs:activate", tabId),
  listTabs: () => ipcRenderer.invoke("tabs:list"),

  // Data queries
  getRequests: (sessionId: string) =>
    ipcRenderer.invoke("data:requests", sessionId),
  getHooks: (sessionId: string) => ipcRenderer.invoke("data:hooks", sessionId),
  getStorage: (sessionId: string) =>
    ipcRenderer.invoke("data:storage", sessionId),
  getReports: (sessionId: string) =>
    ipcRenderer.invoke("data:reports", sessionId),
  clearCaptureData: (sessionId: string) =>
    ipcRenderer.invoke("data:clear", sessionId),

  // AI analysis
  startAnalysis: (sessionId: string, purpose?: string, selectedSeqs?: number[]) =>
    ipcRenderer.invoke("ai:analyze", sessionId, purpose, selectedSeqs),
  sendFollowUp: (sessionId: string, history: unknown[], userMessage: string) =>
    ipcRenderer.invoke("ai:chat", sessionId, history, userMessage),

  // Browser bounds sync (renderer → main, fire-and-forget)
  syncBrowserBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => ipcRenderer.send("browser:syncBounds", bounds),

  // Settings
  getLLMConfig: () => ipcRenderer.invoke("settings:getLLM"),
  saveLLMConfig: (config: unknown) =>
    ipcRenderer.invoke("settings:saveLLM", config),

  // Auto update
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.send("update:install"),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    ipcRenderer.on("update:status", (_event, status) => callback(status));
  },

  // Prompt Templates
  getPromptTemplates: () => ipcRenderer.invoke("templates:list"),
  savePromptTemplate: (template: unknown) =>
    ipcRenderer.invoke("templates:save", template),
  deletePromptTemplate: (id: string) =>
    ipcRenderer.invoke("templates:delete", id),
  resetPromptTemplate: (id: string) =>
    ipcRenderer.invoke("templates:reset", id),

  // MCP Servers
  getMCPServers: () => ipcRenderer.invoke("mcp:list"),
  saveMCPServer: (server: unknown) => ipcRenderer.invoke("mcp:save", server),
  deleteMCPServer: (id: string) => ipcRenderer.invoke("mcp:delete", id),

  // Export requests
  exportRequests: (sessionId: string) =>
    ipcRenderer.invoke("data:exportRequests", sessionId),

  // Proxy
  getProxyConfig: () => ipcRenderer.invoke("proxy:get"),
  saveProxyConfig: (config: unknown) =>
    ipcRenderer.invoke("proxy:save", config),

  // Browser environment
  clearBrowserEnv: () => ipcRenderer.invoke("browser:clearEnv"),

  // MCP Server
  getMCPServerConfig: () => ipcRenderer.invoke("mcp-server:getConfig"),
  saveMCPServerConfig: (config: unknown) =>
    ipcRenderer.invoke("mcp-server:saveConfig", config),
  getMCPServerStatus: () => ipcRenderer.invoke("mcp-server:status"),

  // MITM Proxy
  getMitmProxyConfig: () => ipcRenderer.invoke("mitm-proxy:getConfig"),
  saveMitmProxyConfig: (config: unknown) => ipcRenderer.invoke("mitm-proxy:saveConfig", config),
  getMitmProxyStatus: () => ipcRenderer.invoke("mitm-proxy:status"),
  installMitmCA: () => ipcRenderer.invoke("mitm-proxy:installCA"),
  uninstallMitmCA: () => ipcRenderer.invoke("mitm-proxy:uninstallCA"),
  exportMitmCA: () => ipcRenderer.invoke("mitm-proxy:exportCA"),
  regenerateMitmCA: () => ipcRenderer.invoke("mitm-proxy:regenerateCA"),
  enableMitmSystemProxy: () => ipcRenderer.invoke("mitm-proxy:enableSystemProxy"),
  disableMitmSystemProxy: () => ipcRenderer.invoke("mitm-proxy:disableSystemProxy"),

  // Tab events
  onTabCreated: (callback: (tab: unknown) => void) => {
    ipcRenderer.on("tabs:created", (_event, data) => callback(data));
  },
  onTabClosed: (callback: (data: unknown) => void) => {
    ipcRenderer.on("tabs:closed", (_event, data) => callback(data));
  },
  onTabActivated: (callback: (data: unknown) => void) => {
    ipcRenderer.on("tabs:activated", (_event, data) => callback(data));
  },
  onTabUpdated: (callback: (data: unknown) => void) => {
    ipcRenderer.on("tabs:updated", (_event, data) => callback(data));
  },

  // Events from main process
  onRequestCaptured: (callback: (data: unknown) => void) => {
    ipcRenderer.on("capture:request", (_event, data) => callback(data));
  },
  onHookCaptured: (callback: (data: unknown) => void) => {
    ipcRenderer.on("capture:hook", (_event, data) => callback(data));
  },
  onAnalysisProgress: (callback: (chunk: string) => void) => {
    ipcRenderer.on("ai:progress", (_event, chunk) => callback(chunk));
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
