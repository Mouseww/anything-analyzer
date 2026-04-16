// ============================================================
// Shared type definitions for main process and renderer process
// ============================================================

/**
 * Anything Analyzer 共享类型定义
 *
 * 命名约定说明：
 * - CapturedRequest: 直接从 CDP 捕获的请求，使用 snake_case，与数据库表字段对应
 * - FilteredRequest: 内存中处理过的请求数据，使用 camelCase，便于 JavaScript/TypeScript 代码使用
 * - SceneHint, AuthChainItem: AI 分析结果类型，使用 camelCase
 */

// ---- Session ----

export type SessionStatus = "running" | "paused" | "stopped";

export interface Session {
  id: string;
  name: string;
  target_url: string;
  status: SessionStatus;
  created_at: number;
  stopped_at: number | null;
}

// ---- Captured Request ----

export interface CapturedRequest {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: number;
  method: string;
  url: string;
  request_headers: string; // JSON
  request_body: string | null;
  status_code: number | null;
  response_headers: string | null; // JSON
  response_body: string | null;
  content_type: string | null;
  initiator: string | null; // JSON
  duration_ms: number | null;
  // 流式通信标记
  is_streaming: boolean; // 用于识别 SSE（Server-Sent Events）响应，Content-Type 为 text/event-stream 时为 true
  is_websocket: boolean; // 用于标记 WebSocket 升级请求，Upgrade 头为 websocket 时为 true
  source?: 'cdp' | 'proxy';
}

// ---- JS Hook Record ----

export type HookType = "fetch" | "xhr" | "crypto" | "crypto_lib" | "cookie_set";

export interface JsHookRecord {
  id: number;
  session_id: string;
  timestamp: number;
  hook_type: HookType;
  function_name: string;
  arguments: string; // JSON
  result: string | null; // JSON
  call_stack: string | null;
  related_request_id: string | null;
}

// ---- Storage Snapshot ----

export type StorageType = "cookie" | "localStorage" | "sessionStorage";

export interface StorageSnapshot {
  id: number;
  session_id: string;
  timestamp: number;
  domain: string;
  storage_type: StorageType;
  data: string; // JSON
}

// ---- Analysis Report ----

export interface AnalysisReport {
  id: string;
  session_id: string;
  created_at: number;
  llm_provider: string;
  llm_model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  report_content: string; // Markdown
  filter_prompt_tokens: number | null; // Phase 1 预过滤 token 消耗
  filter_completion_tokens: number | null;
}

// ---- Request Summary (Phase 1 预过滤) ----

/** Phase 1 轻量请求摘要，用于 AI 相关性过滤 */
export interface RequestSummary {
  seq: number;
  method: string;
  url: string;
  status: number | null;
  contentType: string | null;
}

// ---- Scene Hint ----

export interface SceneHint {
  scene: string; // 场景标签：ai-chat, auth-oauth, auth-token, auth-session, registration, login, websocket, sse-stream, api-general
  confidence: "high" | "medium" | "low";
  evidence: string; // 判断依据示例："POST /v1/chat/completions with stream:true", "SSE response detected"
  relatedRequestIds: string[]; // 关联的请求ID数组
}

// ---- Auth Chain Item ----

export interface AuthChainItem {
  source: string; // 凭据获取来源。格式示例："POST /api/login 响应"、"Set-Cookie header"
  credentialType: string; // 凭据类型：Bearer Token, Refresh Token, Session Cookie, Token
  credential: string; // 凭据值（脱敏处理：仅保留前后各8个字符）。格式示例："Bearer eyJ...xxx"
  consumers: string[]; // 使用该凭据的后续请求路径数组
}

// ---- Chat Message ----

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---- Browser Tab ----

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  isActive: boolean;
}

// ---- Auto Update ----

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdateStatus {
  state: UpdateState;
  info?: UpdateInfo;
  progress?: UpdateProgress;
  error?: string;
}

// ---- LLM Provider Config ----

export type LLMProviderType = "openai" | "anthropic" | "custom";
export type OpenAIApiType = "completions" | "responses";

export interface LLMProviderConfig {
  name: LLMProviderType;
  apiType?: OpenAIApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

// ---- Prompt Template ----

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  requirements: string;
  isBuiltin: boolean;
  isModified: boolean;
}

// ---- MCP Server Config ----

interface MCPServerConfigBase {
  id: string;
  name: string;
  enabled: boolean;
}

export interface MCPServerConfigStdio extends MCPServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface MCPServerConfigHttp extends MCPServerConfigBase {
  transport: "streamableHttp";
  url: string;
  headers?: Record<string, string>;
}

export type MCPServerConfig = MCPServerConfigStdio | MCPServerConfigHttp;

// ---- Proxy Config ----

export interface ProxyConfig {
  type: "none" | "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface MCPServerSettings {
  enabled: boolean;
  port: number;
}

// ---- MITM Proxy ----

export interface MitmProxyConfig {
  enabled: boolean;
  port: number;
  caInstalled: boolean;
  systemProxy: boolean;
}

export interface MitmProxyStatus {
  running: boolean;
  port: number | null;
  caInitialized: boolean;
  caInstalled: boolean;
  caCertPath: string | null;
  systemProxyEnabled: boolean;
}

// ---- Filtered Request ----

export interface FilteredRequest {
  seq: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  status: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  hooks: JsHookRecord[];
}

// ---- Crypto Script Snippet ----

export interface CryptoScriptSnippet {
  scriptUrl: string;
  lineRange: [number, number];
  content: string;
  matchedPatterns: string[];
  tier: 1 | 2 | 3;
}

// ---- Assembled Data ----

export interface StorageDiff {
  added: Record<string, string>;
  changed: Record<string, { old: string; new: string }>;
  removed: string[];
}

export interface AssembledData {
  requests: FilteredRequest[];
  storageDiff: {
    cookies: StorageDiff;
    localStorage: StorageDiff;
    sessionStorage: StorageDiff;
  };
  estimatedTokens: number;
  // AI 分析增强字段
  sceneHints: SceneHint[]; // 通过规则推理检测的业务场景线索（如注册、登录、AI 对话等）
  streamingRequests: FilteredRequest[]; // 流式通信请求（SSE 或 WebSocket），从 is_streaming/is_websocket 标记判断
  authChain: AuthChainItem[]; // 身份认证链：凭据来源、类型、值及使用者
  cryptoScripts: CryptoScriptSnippet[]; // 从已捕获的 JS 文件中提取的加密相关代码片段
}

// ---- Analysis Purpose ----

export const ANALYSIS_PURPOSES = [
  { label: '自动识别', value: 'auto', description: '默认 — AI 自动检测场景并生成通用分析' },
  { label: '逆向 API 协议', value: 'reverse-api', description: '聚焦 API 端点、请求/响应模式、鉴权流程、数据模型、复现代码' },
  { label: '安全审计', value: 'security-audit', description: '聚焦认证安全、敏感数据暴露、CSRF/XSS 风险、权限控制' },
  { label: '性能分析', value: 'performance', description: '聚焦请求时序、冗余请求、资源加载、缓存策略' },
  { label: 'JS加密逆向', value: 'crypto-reverse', description: '聚焦JS加密算法识别、加密流程还原、密钥分析、Python复现代码' },
  { label: '自定义...', value: 'custom', description: '输入自定义分析指令' },
] as const;

export type AnalysisPurposeId = (typeof ANALYSIS_PURPOSES)[number]['value'];

// ---- IPC Channel Names ----

export const IPC_CHANNELS = {
  // Session
  SESSION_CREATE: "session:create",
  SESSION_LIST: "session:list",
  SESSION_START: "session:start",
  SESSION_PAUSE: "session:pause",
  SESSION_RESUME: "session:resume",
  SESSION_STOP: "session:stop",
  SESSION_DELETE: "session:delete",

  // Browser
  BROWSER_NAVIGATE: "browser:navigate",
  BROWSER_BACK: "browser:back",
  BROWSER_FORWARD: "browser:forward",
  BROWSER_RELOAD: "browser:reload",
  BROWSER_CLEAR_ENV: "browser:clearEnv",

  // Data
  DATA_REQUESTS: "data:requests",
  DATA_HOOKS: "data:hooks",
  DATA_STORAGE: "data:storage",
  DATA_CLEAR: "data:clear",
  DATA_EXPORT_REQUESTS: "data:exportRequests",

  // AI
  AI_ANALYZE: "ai:analyze",
  AI_PROGRESS: "ai:progress",
  AI_CHAT: "ai:chat",

  // Settings
  SETTINGS_GET_LLM: "settings:getLLM",
  SETTINGS_SAVE_LLM: "settings:saveLLM",

  // Tabs
  TABS_CREATE: "tabs:create",
  TABS_CLOSE: "tabs:close",
  TABS_ACTIVATE: "tabs:activate",
  TABS_LIST: "tabs:list",

  // Tab events (main → renderer)
  TABS_CREATED: "tabs:created",
  TABS_CLOSED: "tabs:closed",
  TABS_ACTIVATED: "tabs:activated",
  TABS_UPDATED: "tabs:updated",

  // Capture events (main → renderer)
  CAPTURE_REQUEST: "capture:request",
  CAPTURE_HOOK: "capture:hook",

  // Update
  APP_VERSION: "app:version",
  UPDATE_CHECK: "update:check",
  UPDATE_INSTALL: "update:install",
  UPDATE_STATUS: "update:status",

  // Prompt Templates
  TEMPLATES_LIST: "templates:list",
  TEMPLATES_SAVE: "templates:save",
  TEMPLATES_DELETE: "templates:delete",
  TEMPLATES_RESET: "templates:reset",

  // MCP Servers
  MCP_LIST: "mcp:list",
  MCP_SAVE: "mcp:save",
  MCP_DELETE: "mcp:delete",

  // Proxy
  PROXY_GET: "proxy:get",
  PROXY_SAVE: "proxy:save",

  // MCP Server
  MCP_SERVER_GET_CONFIG: "mcp-server:getConfig",
  MCP_SERVER_SAVE_CONFIG: "mcp-server:saveConfig",
  MCP_SERVER_STATUS: "mcp-server:status",

  // MITM Proxy
  MITM_GET_CONFIG: "mitm-proxy:getConfig",
  MITM_SAVE_CONFIG: "mitm-proxy:saveConfig",
  MITM_STATUS: "mitm-proxy:status",
  MITM_INSTALL_CA: "mitm-proxy:installCA",
  MITM_UNINSTALL_CA: "mitm-proxy:uninstallCA",
  MITM_EXPORT_CA: "mitm-proxy:exportCA",
  MITM_REGENERATE_CA: "mitm-proxy:regenerateCA",
  MITM_ENABLE_SYSTEM_PROXY: "mitm-proxy:enableSystemProxy",
  MITM_DISABLE_SYSTEM_PROXY: "mitm-proxy:disableSystemProxy",
} as const;

// ---- Electron API (exposed via contextBridge) ----

export interface ElectronAPI {
  createSession: (name: string, targetUrl: string) => Promise<Session>;
  listSessions: () => Promise<Session[]>;
  startCapture: (sessionId: string) => Promise<void>;
  pauseCapture: (sessionId: string) => Promise<void>;
  resumeCapture: (sessionId: string) => Promise<void>;
  stopCapture: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;

  navigate: (url: string) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;
  setBrowserRatio: (ratio: number) => Promise<void>;
  setTargetViewVisible: (visible: boolean) => Promise<void>;
  exportFile: (defaultName: string, content: string) => Promise<boolean>;

  getRequests: (sessionId: string) => Promise<CapturedRequest[]>;
  getHooks: (sessionId: string) => Promise<JsHookRecord[]>;
  getStorage: (sessionId: string) => Promise<StorageSnapshot[]>;
  getReports: (sessionId: string) => Promise<AnalysisReport[]>;
  clearCaptureData: (sessionId: string) => Promise<void>;

  startAnalysis: (sessionId: string, purpose?: string, selectedSeqs?: number[]) => Promise<AnalysisReport>;
  sendFollowUp: (sessionId: string, history: ChatMessage[], userMessage: string) => Promise<string>;
  syncBrowserBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;

  getLLMConfig: () => Promise<LLMProviderConfig | null>;
  saveLLMConfig: (config: LLMProviderConfig) => Promise<void>;

  // Tab management
  createTab: (url?: string) => Promise<BrowserTab>;
  closeTab: (tabId: string) => Promise<void>;
  activateTab: (tabId: string) => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;

  // Tab events
  onTabCreated: (callback: (tab: BrowserTab) => void) => void;
  onTabClosed: (callback: (data: { tabId: string }) => void) => void;
  onTabActivated: (
    callback: (data: { tabId: string; url: string; title: string }) => void,
  ) => void;
  onTabUpdated: (
    callback: (data: { tabId: string; url?: string; title?: string }) => void,
  ) => void;

  onRequestCaptured: (callback: (data: CapturedRequest) => void) => void;
  onHookCaptured: (callback: (data: JsHookRecord) => void) => void;
  onAnalysisProgress: (callback: (chunk: string) => void) => void;
  removeAllListeners: (channel: string) => void;

  // Auto update
  getAppVersion: () => Promise<string>;
  checkForUpdate: () => Promise<void>;
  installUpdate: () => void;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => void;

  // Prompt Templates
  getPromptTemplates: () => Promise<PromptTemplate[]>;
  savePromptTemplate: (template: PromptTemplate) => Promise<void>;
  deletePromptTemplate: (id: string) => Promise<void>;
  resetPromptTemplate: (id: string) => Promise<void>;

  // MCP Servers
  getMCPServers: () => Promise<MCPServerConfig[]>;
  saveMCPServer: (server: MCPServerConfig) => Promise<void>;
  deleteMCPServer: (id: string) => Promise<void>;

  // Export requests
  exportRequests: (sessionId: string) => Promise<boolean>;

  // Proxy
  getProxyConfig: () => Promise<ProxyConfig | null>;
  saveProxyConfig: (config: ProxyConfig) => Promise<void>;

  // Browser environment
  clearBrowserEnv: () => Promise<void>;

  // MCP Server
  getMCPServerConfig: () => Promise<MCPServerSettings>;
  saveMCPServerConfig: (config: MCPServerSettings) => Promise<void>;
  getMCPServerStatus: () => Promise<{ running: boolean; port: number | null }>;

  // MITM Proxy
  getMitmProxyConfig: () => Promise<MitmProxyConfig>;
  saveMitmProxyConfig: (config: MitmProxyConfig) => Promise<void>;
  getMitmProxyStatus: () => Promise<MitmProxyStatus>;
  installMitmCA: () => Promise<{ success: boolean; error?: string }>;
  uninstallMitmCA: () => Promise<{ success: boolean; error?: string }>;
  exportMitmCA: () => Promise<boolean>;
  regenerateMitmCA: () => Promise<void>;
  enableMitmSystemProxy: () => Promise<{ success: boolean; error?: string }>;
  disableMitmSystemProxy: () => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
