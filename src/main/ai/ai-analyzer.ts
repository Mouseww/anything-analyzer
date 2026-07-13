import { v4 as uuidv4 } from "uuid";
import type { AnalysisReport, AssembledData, FilteredRequest, LLMProviderConfig, PromptTemplate, AiRequestLogData } from "@shared/types";
import type {
  SessionsRepo,
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  AiRequestLogRepo,
} from "../db/repositories";
import { DataAssembler } from "./data-assembler";
import { PromptBuilder } from "./prompt-builder";
import { LLMRouter } from "./llm-router";
import type { MCPClientManager, MCPToolInfo } from "../mcp/mcp-manager";
import { compactChatMessages, DEFAULT_CHAT_CONTEXT_CHARS } from "./context-budget";

/** 请求数低于此值时跳过 Phase 1 预过滤 */
const PRE_FILTER_THRESHOLD = 20;
/** Phase 1 选出的请求少于此值时回退到全量分析 */
const PRE_FILTER_MIN_SELECTED = 3;
/** Phase 1 响应最大 token 数 */
const PHASE1_MAX_TOKENS = 1024;
/** 需要全量请求的分析目的（不跳过任何请求） */
const SKIP_FILTER_PURPOSES = ["performance"];
/** 预过滤每次发送的请求摘要上限，避免单次上下文膨胀 */
const FILTER_BATCH_SIZE = 100;

/** 内置 tool：查看请求详情 */
const BUILTIN_TOOLS: MCPToolInfo[] = [
  {
    serverName: '_builtin',
    name: 'get_request_detail',
    description: '获取指定序号的HTTP请求的完整详细内容，包括所有请求头、请求体、响应头和响应体。当你需要查看被过滤掉的请求或需要查看完整的请求/响应内容时使用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        seq: {
          type: 'number',
          description: '请求序号（从完整请求索引中获取）',
        },
      },
      required: ['seq'],
    },
  },
];

/**
 * AiAnalyzer — Orchestrates data assembly, prompt building, LLM calling,
 * and report generation.
 */
export class AiAnalyzer {
  private mcpManager: MCPClientManager | null = null;

  constructor(
    private sessionsRepo: SessionsRepo,
    private requestsRepo: RequestsRepo,
    private jsHooksRepo: JsHooksRepo,
    private storageSnapshotsRepo: StorageSnapshotsRepo,
    private reportsRepo: AnalysisReportsRepo,
    private aiRequestLogRepo: AiRequestLogRepo,
  ) {}

  /**
   * 注入 MCP 客户端管理器（可选）
   */
  setMCPManager(manager: MCPClientManager): void {
    this.mcpManager = manager;
  }

  /**
   * Create a logging callback for LLMRouter that captures context via closure.
   */
  private createLogCallback(
    sessionId: string,
    reportId: string | null,
    type: 'analyze' | 'chat' | 'filter',
    config: LLMProviderConfig,
  ) {
    return (data: AiRequestLogData) => {
      try {
        this.aiRequestLogRepo.insert({
          session_id: sessionId,
          report_id: reportId,
          type,
          provider: config.name,
          model: config.model,
          ...data,
          prompt_tokens: 0,
          completion_tokens: 0,
          created_at: Date.now(),
        });
      } catch (e) {
        console.warn('[AiRequestLog] Failed to insert log:', e);
      }
    };
  }

  async analyze(
    sessionId: string,
    config: LLMProviderConfig,
    onProgress?: (chunk: string) => void,
    purpose?: string,
    template?: PromptTemplate,
    selectedSeqs?: number[],
    signal?: AbortSignal,
  ): Promise<AnalysisReport> {
    // Get session info
    const session = this.sessionsRepo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Extract platform name from target URL
    let platformName = "unknown";
    try {
      platformName = new URL(session.target_url).hostname;
    } catch {
      /* ignore */
    }

    // Assemble data
    const assembler = new DataAssembler(
      this.requestsRepo,
      this.jsHooksRepo,
      this.storageSnapshotsRepo,
    );
    const fullData = assembler.assemble(sessionId);

    if (fullData.requests.length === 0) {
      throw new Error("No captured requests to analyze");
    }

    // 手动选择模式：跳过 Phase 1，直接过滤
    const manualSelection = selectedSeqs && selectedSeqs.length > 0;
    let analysisData: AssembledData = fullData;
    let filterPromptTokens: number | null = null;
    let filterCompletionTokens: number | null = null;
    let allSummaries = undefined as ReturnType<DataAssembler['extractSummaries']> | undefined;

    if (manualSelection) {
      analysisData = assembler.filterBySeqs(fullData, selectedSeqs);
      onProgress?.(`> 手动选择模式：分析 ${analysisData.requests.length} 条选中的请求。\n\n`);
    } else {
      // Phase 1: 预过滤（可选）
      const shouldFilter =
        fullData.requests.length >= PRE_FILTER_THRESHOLD &&
        !SKIP_FILTER_PURPOSES.includes(purpose ?? "");

      if (shouldFilter) {
        try {
          onProgress?.(`> 正在过滤：分析 ${fullData.requests.length} 条请求的相关性...\n\n`);

          allSummaries = assembler.extractSummaries(fullData);
          const phase1Config: LLMProviderConfig = { ...config, maxTokens: PHASE1_MAX_TOKENS };
          const phase1Router = new LLMRouter(phase1Config, this.createLogCallback(sessionId, null, 'filter', phase1Config));
          const validSeqs = new Set(fullData.requests.map(r => r.seq));
          const selectedSeqs = new Set<number>();

          for (let batchStart = 0; batchStart < allSummaries.length; batchStart += FILTER_BATCH_SIZE) {
            const batchSummaries = allSummaries.slice(batchStart, batchStart + FILTER_BATCH_SIZE);
            const filterPrompt = new PromptBuilder().buildFilterPrompt(
              batchSummaries,
              fullData.sceneHints,
              purpose,
              template,
            );
            const phase1Messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
              { role: "system", content: filterPrompt.system },
              { role: "user", content: filterPrompt.user },
            ];

            const batchNumber = Math.floor(batchStart / FILTER_BATCH_SIZE) + 1;
            const batchCount = Math.ceil(allSummaries.length / FILTER_BATCH_SIZE);
            onProgress?.(`> 正在过滤第 ${batchNumber}/${batchCount} 批请求（${batchSummaries.length} 条）...\n\n`);
            signal?.throwIfAborted();
            const phase1Result = await phase1Router.complete(phase1Messages, undefined, signal);
            filterPromptTokens = (filterPromptTokens ?? 0) + phase1Result.promptTokens;
            filterCompletionTokens = (filterCompletionTokens ?? 0) + phase1Result.completionTokens;
            this.aiRequestLogRepo.updateLatestTokens(sessionId, 'filter', phase1Result.promptTokens, phase1Result.completionTokens);
            this.parseFilterResponse(phase1Result.content, validSeqs)?.forEach((seq) => selectedSeqs.add(seq));
          }

          const filteredSeqs = [...selectedSeqs];

          if (filteredSeqs.length >= PRE_FILTER_MIN_SELECTED) {
            analysisData = assembler.filterBySeqs(fullData, filteredSeqs);
            onProgress?.(`> 过滤完成：从 ${fullData.requests.length} 条中选出 ${filteredSeqs.length} 条相关请求进行深度分析。\n\n`);
          } else {
            onProgress?.(`> 过滤结果不足，使用全部 ${fullData.requests.length} 条请求分析。\n\n`);
            allSummaries = undefined; // 未过滤，不需要完整索引
          }
        } catch {
          onProgress?.(`> 预过滤失败，使用全部 ${fullData.requests.length} 条请求分析。\n\n`);
          allSummaries = undefined;
        }
      }
    }

    // Phase 2: 深度分析
    const promptBuilder = new PromptBuilder();
    // 仅当 Phase 1 实际过滤生效时才传入全量摘要（生成完整请求索引 + 工具提示）
    const filteredApplied = analysisData !== fullData;
    const { system, user } = promptBuilder.build(
      analysisData, platformName, purpose, template,
      filteredApplied ? allSummaries : undefined,
    );

    // Call LLM with retry
    const router = new LLMRouter(config, this.createLogCallback(sessionId, null, 'analyze', config));
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;

    // 构建请求查找表（内置 tool 用）
    const requestMap = new Map(fullData.requests.map(r => [r.seq, r]));

    // 仅当 Phase 1 过滤生效（非手动选择）时才提供内置 tool
    const builtinTools = (filteredApplied && !manualSelection) ? BUILTIN_TOOLS : [];
    const mcpTools = this.mcpManager?.hasConnections()
      ? this.mcpManager.listAllTools()
      : [];
    const allTools = [...builtinTools, ...mcpTools];

    // tool 调用路由：内置 tool 本地处理，其他委托给 MCP
    const mcpMgr = this.mcpManager;
    const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name === 'get_request_detail') {
        const seq = typeof args.seq === 'number' ? args.seq : Number(args.seq);
        const req = requestMap.get(seq);
        if (!req) return `Error: 未找到序号为 ${seq} 的请求`;
        return this.formatRequestDetail(req);
      }
      if (mcpMgr) return mcpMgr.callTool(name, args);
      throw new Error(`Tool not found: ${name}`);
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        signal?.throwIfAborted();
        const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
          { role: "system", content: system },
          { role: "user", content: user },
        ];

        let result;
        if (allTools.length > 0) {
          // 有工具可用时走 agentic loop（非流式，但支持 tool calling）
          result = await router.completeWithTools(
            messages,
            allTools,
            callTool,
            onProgress,
            undefined,
            signal,
          );
        } else {
          // 无工具时走流式调用（保持逐字输出 UX）
          result = await router.complete(messages, onProgress, signal);
        }

        content = result.content;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;
        this.aiRequestLogRepo.updateLatestTokens(sessionId, 'analyze', result.promptTokens, result.completionTokens);
        break;
      } catch (err) {
        // Don't retry if cancelled
        if (signal?.aborted) throw err;
        if (attempt === 1)
          throw new Error(
            `AI 分析失败（已重试）: ${(err as Error).message}`,
          );
      }
    }

    // Save report
    const report: AnalysisReport = {
      id: uuidv4(),
      session_id: sessionId,
      created_at: Date.now(),
      llm_provider: config.name,
      llm_model: config.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      report_content: content,
      filter_prompt_tokens: filterPromptTokens,
      filter_completion_tokens: filterCompletionTokens,
    };

    this.reportsRepo.insert(report);

    return report;
  }

  /**
   * 解析 Phase 1 过滤响应：提取 JSON 数组中的有效序号
   */
  private parseFilterResponse(raw: string, validSeqs: Set<number>): number[] | null {
    let cleaned = raw.trim();
    // 去除 markdown 代码块包裹
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');

    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return null;
      const nums = parsed.filter(
        (n): n is number => typeof n === 'number' && validSeqs.has(n),
      );
      return nums.length > 0 ? nums : null;
    } catch {
      return null;
    }
  }

  /**
   * 格式化单个请求的完整详情（内置 tool 返回值）
   */
  private formatRequestDetail(req: FilteredRequest): string {
    const lines = [
      `# 请求 #${req.seq}`,
      `${req.method} ${req.url} → ${req.status ?? 'pending'}`,
      '',
      '## 请求头',
      JSON.stringify(req.headers, null, 2),
    ];
    if (req.body) {
      lines.push('', '## 请求体', req.body);
    }
    if (req.responseHeaders) {
      lines.push('', '## 响应头', JSON.stringify(req.responseHeaders, null, 2));
    }
    if (req.responseBody) {
      lines.push('', '## 响应体', req.responseBody);
    }
    if (req.hooks.length > 0) {
      lines.push('', '## 关联 JS Hooks');
      for (const h of req.hooks) {
        lines.push(`[${h.hook_type}] ${h.function_name}: args=${h.arguments}${h.result ? ` result=${h.result}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  async chat(
    sessionId: string,
    config: LLMProviderConfig,
    history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userMessage: string,
    onProgress?: (chunk: string) => void,
    reportId?: string,
  ): Promise<string> {
    // Build messages array: existing history + new user message
    const messages = [
      ...history,
      { role: 'user' as const, content: userMessage },
    ]

    // Deterministic compaction avoids an extra summarization request and keeps
    // follow-up requests on the same provider path as analysis.
    const compactedMessages = compactChatMessages(messages, DEFAULT_CHAT_CONTEXT_CHARS);

    const router = new LLMRouter(config, this.createLogCallback(sessionId, reportId ?? null, 'chat', config))

    // Build request lookup for builtin tool
    const assembler = new DataAssembler(
      this.requestsRepo,
      this.jsHooksRepo,
      this.storageSnapshotsRepo,
    );
    const fullData = assembler.assemble(sessionId);
    const requestMap = new Map(fullData.requests.map(r => [r.seq, r]));

    // Collect available tools: builtin + MCP
    const builtinTools = fullData.requests.length > 0 ? BUILTIN_TOOLS : [];
    const mcpTools = this.mcpManager?.hasConnections()
      ? this.mcpManager.listAllTools()
      : [];
    const allTools = [...builtinTools, ...mcpTools];

    const mcpMgr = this.mcpManager;

    // Collect tool interactions for context preservation
    const toolInteractions: string[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      let result: string;
      if (name === 'get_request_detail') {
        const seq = typeof args.seq === 'number' ? args.seq : Number(args.seq);
        const req = requestMap.get(seq);
        if (!req) {
          result = `Error: 未找到序号为 ${seq} 的请求`;
        } else {
          result = this.formatRequestDetail(req);
        }
      } else if (mcpMgr) {
        result = await mcpMgr.callTool(name, args);
      } else {
        throw new Error(`Tool not found: ${name}`);
      }

      // Record tool interaction for context preservation across turns
      const argsStr = JSON.stringify(args);
      toolInteractions.push(`[${name}](${argsStr})\n${result}`);

      return result;
    };

    let replyContent: string;

    if (allTools.length > 0) {
      try {
        const result = await router.completeWithTools(compactedMessages, allTools, callTool, onProgress);
        this.aiRequestLogRepo.updateLatestTokens(sessionId, 'chat', result.promptTokens, result.completionTokens);
        replyContent = result.content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`追问工具调用失败：${message}`);
      }
    } else {
      const result = await router.complete(compactedMessages, onProgress);
      this.aiRequestLogRepo.updateLatestTokens(sessionId, 'chat', result.promptTokens, result.completionTokens);
      replyContent = result.content;
    }

    // Embed tool interaction context in assistant reply for future turns
    if (toolInteractions.length > 0) {
      const ctx = toolInteractions.join('\n---\n');
      replyContent += `\n\n<tool_context>\n${ctx}\n</tool_context>`;
    }

    return replyContent;
  }

}
