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

  // AI analysis
  startAnalysis: (sessionId: string, purpose?: string) =>
    ipcRenderer.invoke("ai:analyze", sessionId, purpose),

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
