import { contextBridge, ipcRenderer } from "electron";

// Forward JS hook messages from the target page context to the main process.
// The hook script (injected via executeJavaScript) uses window.postMessage
// to send captured data; we relay it over IPC.
window.addEventListener("message", (event) => {
  if (event.data?.type === "ar-hook") {
    ipcRenderer.send("capture:hook-data", event.data);
  }
  if (event.data?.type === "ar-interaction") {
    ipcRenderer.send("capture:hook-data", event.data);
  }
});

// Expose IPC APIs to renderer
contextBridge.exposeInMainWorld("electronAPI", {
  // Window control (frameless window)
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  isWindowMaximized: () => ipcRenderer.invoke("window:isMaximized"),

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
  toggleDevTools: () => ipcRenderer.invoke("browser:toggleDevTools"),
  exportFile: (defaultName: string, content: string) =>
    ipcRenderer.invoke("dialog:exportFile", defaultName, content),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),

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
  cancelAnalysis: (sessionId: string) =>
    ipcRenderer.invoke("ai:cancel", sessionId),
  sendFollowUp: (sessionId: string, reportId: string, history: unknown[], userMessage: string) =>
    ipcRenderer.invoke("ai:chat", sessionId, reportId, history, userMessage),
  getChatMessages: (reportId: string) =>
    ipcRenderer.invoke("data:chatMessages", reportId),
  saveChatMessages: (reportId: string, messages: unknown[]) =>
    ipcRenderer.invoke("data:saveChatMessages", reportId, messages),

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

  // AI Request Logs
  getAiRequestLogs: (sessionId: string) => ipcRenderer.invoke("data:aiRequestLogs", sessionId),
  getAiRequestLogsAll: (limit: number, offset: number) => ipcRenderer.invoke("data:aiRequestLogsAll", limit, offset),
  getAiRequestLogDetail: (id: number) => ipcRenderer.invoke("data:aiRequestLogDetail", id),

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

  // Interaction Recording
  getInteractions: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke("interaction:getEvents", sessionId, limit),
  getInteractionCount: (sessionId: string) =>
    ipcRenderer.invoke("interaction:getCount", sessionId),
  clearInteractions: (sessionId: string) =>
    ipcRenderer.invoke("interaction:clear", sessionId),
  onInteractionRecorded: (callback: (data: unknown) => void) => {
    ipcRenderer.on("interaction:recorded", (_event, data) => callback(data));
  },

  // Fingerprint
  getFingerprintProfile: (sessionId: string) =>
    ipcRenderer.invoke("fingerprint:get", sessionId),
  updateFingerprintProfile: (profile: unknown) =>
    ipcRenderer.invoke("fingerprint:update", JSON.stringify(profile)),
  regenerateFingerprintProfile: (sessionId: string) =>
    ipcRenderer.invoke("fingerprint:regenerate", sessionId),
  enableFingerprint: (sessionId: string) =>
    ipcRenderer.invoke("fingerprint:enable", sessionId),
  disableFingerprint: () =>
    ipcRenderer.invoke("fingerprint:disable"),

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
  onStorageCaptured: (callback: (data: unknown) => void) => {
    ipcRenderer.on("capture:storage", (_event, data) => callback(data));
  },
  onAnalysisProgress: (callback: (chunk: string) => void) => {
    ipcRenderer.on("ai:progress", (_event, chunk) => callback(chunk));
  },

  // Log files
  getLogPath: () => ipcRenderer.invoke("log:getPath"),
  openLogFolder: () => ipcRenderer.invoke("log:openFolder"),
  exportLogs: () => ipcRenderer.invoke("log:export"),

  // Client certificate selection
  selectClientCert: (id: string, index: number) =>
    ipcRenderer.invoke("client-cert:select", id, index),
  cancelClientCert: (id: string) =>
    ipcRenderer.invoke("client-cert:cancel", id),
  onClientCertSelect: (callback: (data: {
    id: string;
    url: string;
    certificates: Array<{
      index: number;
      issuerName: string;
      subjectName: string;
      serialNumber: string;
      validStart: number;
      validExpiry: number;
    }>;
  }) => void) => {
    ipcRenderer.on("client-cert:select", (_event, data) => callback(data));
  },

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
