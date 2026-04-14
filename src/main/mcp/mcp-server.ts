import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { session } from "electron";
import type { SessionManager } from "../session/session-manager";
import type { AiAnalyzer } from "../ai/ai-analyzer";
import type { WindowManager } from "../window";
import type {
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
} from "../db/repositories";
import type { ChatMessage } from "@shared/types";
import { loadLLMConfig } from "../ipc";

interface MCPServerDeps {
  sessionManager: SessionManager;
  aiAnalyzer: AiAnalyzer;
  windowManager: WindowManager;
  requestsRepo: RequestsRepo;
  jsHooksRepo: JsHooksRepo;
  storageSnapshotsRepo: StorageSnapshotsRepo;
  reportsRepo: AnalysisReportsRepo;
}

let httpServer: Server | null = null;
let mcpServer: McpServer | null = null;
const transports = new Map<string, StreamableHTTPServerTransport>();
// Per-session chat history for chat_followup tool
const chatHistories = new Map<string, ChatMessage[]>();

/**
 * Initialize and start the MCP Server on the given port.
 */
export async function initMCPServer(
  deps: MCPServerDeps,
  port: number,
): Promise<void> {
  if (httpServer) await stopMCPServer();

  mcpServer = new McpServer({
    name: "anything-analyzer",
    version: "1.0.0",
  });

  registerTools(mcpServer, deps);
  registerResources(mcpServer, deps);

  httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, mcp-session-id, mcp-protocol-version",
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        "mcp-session-id, mcp-protocol-version",
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://localhost:${port}`);
      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "DELETE") {
          // Close session
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.close();
            transports.delete(sessionId);
            chatHistories.delete(sessionId);
          }
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.method === "GET") {
          // SSE stream for existing session
          if (sessionId && transports.has(sessionId)) {
            await transports.get(sessionId)!.handleRequest(req, res);
            return;
          }
          res.writeHead(400);
          res.end("Missing or invalid session ID");
          return;
        }

        // POST
        const body = await readBody(req);

        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res, body);
        } else if (!sessionId && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              chatHistories.delete(transport.sessionId);
            }
          };
          await mcpServer!.connect(transport);
          await transport.handleRequest(req, res, body);
        } else {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error:
                "Invalid request: missing session ID or not an initialize request",
            }),
          );
        }
      } catch (err) {
        console.error("[MCP Server] Error handling request:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    },
  );

  httpServer.listen(port, () => {
    console.log(`[MCP Server] Listening on http://localhost:${port}/mcp`);
  });
}

/**
 * Stop the MCP Server and close all connections.
 */
export async function stopMCPServer(): Promise<void> {
  for (const transport of transports.values()) {
    await transport.close().catch(() => {});
  }
  transports.clear();
  chatHistories.clear();

  if (mcpServer) {
    await mcpServer.close().catch(() => {});
    mcpServer = null;
  }

  return new Promise((resolve) => {
    if (httpServer) {
      httpServer.close(() => {
        httpServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Check if MCP Server is currently running.
 */
export function isMCPServerRunning(): boolean {
  return httpServer !== null && httpServer.listening;
}

// ---- Tool Registration ----

function registerTools(server: McpServer, deps: MCPServerDeps): void {
  const {
    sessionManager,
    aiAnalyzer,
    windowManager,
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
    reportsRepo,
  } = deps;

  // -- Session Management --

  server.registerTool(
    "list_sessions",
    {
      description: "List all analysis sessions",
    },
    async () => {
      const sessions = sessionManager.listSessions();
      return text(sessions);
    },
  );

  server.registerTool(
    "create_session",
    {
      description: "Create a new analysis session",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        targetUrl: z.string().describe("Target URL to analyze"),
      }),
    },
    async ({ name, targetUrl }) => {
      const s = sessionManager.createSession(name, targetUrl);
      return text(s);
    },
  );

  server.registerTool(
    "start_capture",
    {
      description:
        "Start capturing HTTP requests for a session. The embedded browser must be open.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
      }),
    },
    async ({ sessionId }) => {
      const tabManager = windowManager.getTabManager();
      const mainWin = windowManager.getMainWindow();
      if (!tabManager || !mainWin) throw new Error("Browser not ready");
      await sessionManager.startCapture(
        sessionId,
        tabManager,
        mainWin.webContents,
      );
      return text({ success: true });
    },
  );

  server.registerTool(
    "pause_capture",
    {
      description: "Pause capturing for a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      await sessionManager.pauseCapture(sessionId);
      return text({ success: true });
    },
  );

  server.registerTool(
    "stop_capture",
    {
      description: "Stop capturing and finalize a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      await sessionManager.stopCapture(sessionId);
      return text({ success: true });
    },
  );

  server.registerTool(
    "delete_session",
    {
      description: "Delete a session and all its data",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      await sessionManager.deleteSession(sessionId);
      return text({ success: true });
    },
  );

  // -- Browser Control --

  server.registerTool(
    "navigate",
    {
      description: "Navigate the active browser tab to a URL",
      inputSchema: z.object({ url: z.string().describe("URL to navigate to") }),
    },
    async ({ url }) => {
      await windowManager.navigateTo(url);
      return text({ success: true, url });
    },
  );

  server.registerTool(
    "browser_back",
    {
      description: "Go back in the active browser tab",
    },
    async () => {
      windowManager.goBack();
      return text({ success: true });
    },
  );

  server.registerTool(
    "browser_forward",
    {
      description: "Go forward in the active browser tab",
    },
    async () => {
      windowManager.goForward();
      return text({ success: true });
    },
  );

  server.registerTool(
    "browser_reload",
    {
      description: "Reload the active browser tab",
    },
    async () => {
      windowManager.reload();
      return text({ success: true });
    },
  );

  server.registerTool(
    "create_tab",
    {
      description: "Create a new browser tab",
      inputSchema: z.object({
        url: z.string().optional().describe("Optional URL to open"),
      }),
    },
    async ({ url }) => {
      const tabManager = windowManager.getTabManager();
      if (!tabManager) throw new Error("Browser not ready");
      const tab = tabManager.createTab(url);
      return text({ id: tab.id, url: tab.url, title: tab.title });
    },
  );

  server.registerTool(
    "close_tab",
    {
      description: "Close a browser tab",
      inputSchema: z.object({ tabId: z.string() }),
    },
    async ({ tabId }) => {
      const tabManager = windowManager.getTabManager();
      if (!tabManager) throw new Error("Browser not ready");
      tabManager.closeTab(tabId);
      return text({ success: true });
    },
  );

  server.registerTool(
    "list_tabs",
    {
      description: "List all browser tabs with their URLs and titles",
    },
    async () => {
      const tabManager = windowManager.getTabManager();
      if (!tabManager) throw new Error("Browser not ready");
      const tabs = tabManager.getAllTabs().map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
      }));
      return text(tabs);
    },
  );

  server.registerTool(
    "clear_browser_env",
    {
      description:
        "Clear all browser data (cookies, localStorage, sessionStorage, cache). Current login state will be lost.",
    },
    async () => {
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
      windowManager.getTabManager()?.getActiveWebContents()?.reload();
      return text({ success: true });
    },
  );

  // -- Data Query --

  server.registerTool(
    "get_requests",
    {
      description:
        "Get all captured HTTP requests for a session. Returns method, url, status, headers, body, and response for each request.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const requests = requestsRepo.findBySession(sessionId);
      // Trim large bodies to keep response manageable
      const trimmed = requests.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        method: r.method,
        url: r.url,
        status_code: r.status_code,
        content_type: r.content_type,
        duration_ms: r.duration_ms,
        request_body: r.request_body
          ? r.request_body.length > 2000
            ? r.request_body.substring(0, 2000) + "..."
            : r.request_body
          : null,
        response_body: r.response_body
          ? r.response_body.length > 2000
            ? r.response_body.substring(0, 2000) + "..."
            : r.response_body
          : null,
      }));
      return text(trimmed);
    },
  );

  server.registerTool(
    "get_request_detail",
    {
      description:
        "Get full details of a single captured request including complete headers, body, and response body",
      inputSchema: z.object({ requestId: z.string() }),
    },
    async ({ requestId }) => {
      const req = requestsRepo.findById(requestId);
      if (!req) return text({ error: "Request not found" });
      return text(req);
    },
  );

  server.registerTool(
    "get_hooks",
    {
      description:
        "Get all JS Hook records for a session (crypto operations, XHR/fetch intercepts, etc.)",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const hooks = jsHooksRepo.findBySession(sessionId);
      return text(hooks);
    },
  );

  server.registerTool(
    "get_storage",
    {
      description:
        "Get storage snapshots (cookies, localStorage, sessionStorage) for a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const snapshots = storageSnapshotsRepo.findBySession(sessionId);
      return text(snapshots);
    },
  );

  // -- AI Analysis --

  server.registerTool(
    "run_analysis",
    {
      description:
        "Run AI-powered protocol analysis on captured session data. Uses the LLM configured in app settings. Returns a full analysis report.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID to analyze"),
        purpose: z
          .string()
          .optional()
          .describe(
            "Analysis focus: 'reverse-api', 'security-audit', 'performance', 'crypto-reverse', or custom text",
          ),
        selectedSeqs: z
          .array(z.number())
          .optional()
          .describe("Optional: specific request sequence numbers to analyze"),
      }),
    },
    async ({ sessionId, purpose, selectedSeqs }) => {
      const config = loadLLMConfig();
      if (!config)
        return text({
          error:
            "LLM not configured. Please configure LLM settings in the app first.",
        });
      const report = await aiAnalyzer.analyze(
        sessionId,
        config,
        undefined,
        purpose,
        undefined,
        selectedSeqs,
      );
      return text({
        id: report.id,
        content: report.report_content,
        model: report.llm_model,
      });
    },
  );

  server.registerTool(
    "get_reports",
    {
      description: "Get all analysis reports for a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const reports = reportsRepo.findBySession(sessionId);
      return text(
        reports.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          llm_model: r.llm_model,
          content:
            r.report_content.length > 3000
              ? r.report_content.substring(0, 3000) + "..."
              : r.report_content,
        })),
      );
    },
  );

  server.registerTool(
    "chat_followup",
    {
      description:
        "Send a follow-up question about a previous analysis. Maintains conversation history per session.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
        message: z.string().describe("Follow-up question"),
      }),
    },
    async ({ sessionId, message }) => {
      const config = loadLLMConfig();
      if (!config) return text({ error: "LLM not configured" });

      // Get or initialize chat history for this session
      if (!chatHistories.has(sessionId)) {
        // Load existing report as context
        const reports = reportsRepo.findBySession(sessionId);
        const lastReport = reports[reports.length - 1];
        if (lastReport) {
          chatHistories.set(sessionId, [
            { role: "assistant" as const, content: lastReport.report_content },
          ]);
        } else {
          chatHistories.set(sessionId, []);
        }
      }

      const history = chatHistories.get(sessionId)!;
      const reply = await aiAnalyzer.chat(sessionId, config, history, message);
      // Update history
      history.push({ role: "user" as const, content: message });
      history.push({ role: "assistant" as const, content: reply });

      return text({ reply });
    },
  );
}

// ---- Resource Registration ----

function registerResources(server: McpServer, deps: MCPServerDeps): void {
  const { sessionManager, windowManager } = deps;

  server.registerResource(
    "sessions",
    "sessions://list",
    {
      description: "List of all analysis sessions",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(sessionManager.listSessions(), null, 2),
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.registerResource(
    "app-status",
    "app://status",
    {
      description:
        "Current application status including active session and capture state",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(
            {
              currentSessionId: sessionManager.getCurrentSessionId(),
              mcpServerRunning: isMCPServerRunning(),
            },
            null,
            2,
          ),
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.registerResource(
    "browser-tabs",
    "browser://tabs",
    {
      description: "Current browser tabs",
    },
    async (uri) => {
      const tabs =
        windowManager
          .getTabManager()
          ?.getAllTabs()
          .map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title,
          })) || [];
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(tabs, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}

// ---- Helpers ----

function text(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
