import type { LLMProviderConfig, AiRequestLogData } from "@shared/types";
import type { MCPToolInfo } from "../mcp/mcp-manager";

interface LLMResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // OpenAI tool call fields
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolBinding {
  exposedName: string;
  tool: MCPToolInfo;
}

function createToolBindings(tools: MCPToolInfo[]): ToolBinding[] {
  const usedNames = new Set<string>();
  return tools.map((tool, index) => {
    const baseName = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || `tool_${index + 1}`;
    let exposedName = baseName;
    let suffix = 2;
    while (usedNames.has(exposedName)) {
      const suffixText = `_${suffix}`;
      exposedName = `${baseName.slice(0, 64 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    usedNames.add(exposedName);
    return { exposedName, tool };
  });
}

interface ResponsesIncompleteDetails {
  reason?: string;
}

// Anthropic content block types
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

const DEFAULT_TIMEOUT = 600000; // 10 minutes — LLM relay servers can be slow; user can cancel manually

interface ResponsesOutputItem {
  type: string;
  content?: Array<{ type: string; text?: unknown }>;
}

function extractResponsesOutputText(output: ResponsesOutputItem[]): string {
  let content = "";
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      content += item.content
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
    }
  }
  return content;
}

function readResponsesOutputText(data: {
  output_text?: unknown;
  output?: ResponsesOutputItem[];
}): string {
  const content =
    typeof data.output_text === "string" && data.output_text.length > 0
      ? data.output_text
      : Array.isArray(data.output)
        ? extractResponsesOutputText(data.output)
        : "";

  if (content.length === 0) {
    throw new Error(`LLM 响应格式异常: 缺少 output_text 字段 — ${JSON.stringify(data).slice(0, 200)}`);
  }

  return content;
}

function requireLLMContent(content: string, fieldName: string): string {
  if (content.length === 0) {
    throw new Error(`LLM 响应格式异常: 缺少 ${fieldName} 字段`);
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readToolArguments(argumentsJson: string, fieldName: string): Record<string, unknown> {
  try {
    const args = JSON.parse(argumentsJson);
    if (isRecord(args)) return args;
  } catch {
    // Fall through to the common protocol error below.
  }
  throw new Error(`${fieldName} arguments must be a valid JSON object`);
}

function parseStreamJson<T>(data: string, providerName: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new Error(`${providerName} stream error: malformed JSON payload`);
  }
}

function readStreamTextDelta(
  value: unknown,
  providerName: string,
  fieldName: string,
  required = false,
): string {
  if (typeof value === "string") return value;
  if (!required && value == null) return "";
  throw new Error(`${providerName} stream error: ${fieldName} must be a string`);
}

function readAnthropicTextContent(data: {
  content: Array<{ type: string; text?: unknown }>;
}): string {
  const textBlocks = data.content.filter((block) => block.type === "text");
  if (textBlocks.some((block) => typeof block.text !== "string")) {
    throw new Error(`LLM 响应格式异常: text content 必须是字符串 — ${JSON.stringify(data).slice(0, 200)}`);
  }

  const content = textBlocks.map((block) => block.text as string).join("");
  if (content.length === 0) {
    throw new Error(`LLM 响应格式异常: 缺少 text content 字段 — ${JSON.stringify(data).slice(0, 200)}`);
  }

  return content;
}

/**
 * Sanitize string content in LLM request body to remove control characters
 * that may break JSON parsing in intermediate proxies.
 */
function sanitizeForJson(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // Remove ASCII control chars (except \n \r \t) and Unicode replacement char
    return obj.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, '');
  }
  if (Array.isArray(obj)) return obj.map(sanitizeForJson);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = sanitizeForJson(value);
    }
    return result;
  }
  return obj;
}

/**
 * Mask sensitive values in HTTP headers before logging.
 * "Bearer sk-1234567890abcdef" → "Bearer sk-****cdef"
 */
function maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      masked[key] = masked[key].replace(/(\w{2,4})\w{4,}(\w{4})/, '$1****$2');
    }
  }
  return masked;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * LLMRouter — Unified interface for calling different LLM providers.
 * Supports OpenAI, Anthropic, and OpenAI-compatible APIs.
 */
export class LLMRouter {
  constructor(
    private config: LLMProviderConfig,
    private onRequestComplete?: (log: AiRequestLogData) => void,
  ) {}

  /**
   * Safely parse JSON from a fetch Response.
   * Throws a clear error if the body is not valid JSON (e.g. HTML error pages)
   * or if the API returned a structured error (Anthropic { type: "error" }).
   */
  private async safeParseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Likely HTML or plain text — show a truncated preview
      const preview = text.slice(0, 200).replace(/\n/g, ' ');
      throw new Error(`LLM 返回了非 JSON 响应 (${response.status}): ${preview}`);
    }

    // Anthropic error format: { type: "error", error: { type, message } }
    const obj = data !== null && typeof data === "object"
      ? data as Record<string, unknown>
      : {};
    if (obj.type === 'error' && typeof obj.error === 'object' && obj.error !== null) {
      const err = obj.error as Record<string, unknown>;
      throw new Error(`LLM API 错误: ${err.type ?? 'unknown'} — ${err.message ?? JSON.stringify(err)}`);
    }

    // Responses API failed payloads need endpoint-specific handling.
    if (obj.status === "failed") {
      return data as T;
    }

    // OpenAI error format: { error: { message, type, code } }
    if (typeof obj.error === 'object' && obj.error !== null && !obj.type) {
      const err = obj.error as Record<string, unknown>;
      throw new Error(`LLM API 错误: ${err.message ?? JSON.stringify(err)}`);
    }

    return obj as T;
  }

  async complete(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    if (this.config.name === "anthropic" || this.config.name === "minimax") {
      return this.completeAnthropic(messages, onChunk, signal);
    }
    if (this.config.apiType === "responses") {
      return this.completeResponses(messages, onChunk, signal);
    }
    return this.completeOpenAI(messages, onChunk, signal);
  }

  /**
   * Agentic loop: LLM ↔ tool calls via MCP.
   * Uses non-streaming for tool-call rounds, streams only the final text response.
   */
  async completeWithTools(
    messages: ChatMessage[],
    tools: MCPToolInfo[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk?: (chunk: string) => void,
    _maxRounds = 10,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    if (this.config.name === "anthropic" || this.config.name === "minimax") {
      return this.agenticLoopAnthropic(messages, tools, callTool, onChunk, _maxRounds, signal);
    }
    if (this.config.apiType === "responses") {
      return this.agenticLoopResponses(messages, tools, callTool, onChunk, _maxRounds, signal);
    }
    return this.agenticLoopOpenAI(messages, tools, callTool, onChunk, _maxRounds, signal);
  }

  // ---- Agentic Loop: OpenAI / Custom ----

  private async agenticLoopOpenAI(
    messages: ChatMessage[],
    tools: MCPToolInfo[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk?: (chunk: string) => void,
    _maxRounds = 10,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const bindings = createToolBindings(tools);
    const bindingByExposedName = new Map(bindings.map((binding) => [binding.exposedName, binding]));
    const callBoundTool = (name: string, args: Record<string, unknown>): Promise<string> =>
      callTool(bindingByExposedName.get(name)?.tool.name ?? name, args);
    const openaiTools = bindings.map((binding) => ({
      type: "function" as const,
      function: {
        name: binding.exposedName,
        description: binding.tool.description,
        parameters: binding.tool.inputSchema,
        strict: false,
      },
    }));

    const history = [...messages];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (;;) {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const body = {
        model: this.config.model,
        messages: history.map((m) => {
          const msg: Record<string, unknown> = { role: m.role, content: m.content };
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          return msg;
        }),
        max_tokens: this.config.maxTokens,
        tools: openaiTools,
        stream: false,
      };

      signal?.throwIfAborted();
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(sanitizeForJson(body)),
      }, 1, false, signal);

      const data = await this.safeParseJson<{
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: ToolCall[];
            role: string;
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>(response);

      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error(`LLM 响应格式异常: 缺少 choices 字段 — ${JSON.stringify(data).slice(0, 200)}`);
      }

      totalPromptTokens += data.usage?.prompt_tokens || 0;
      totalCompletionTokens += data.usage?.completion_tokens || 0;

      const choice = data.choices[0];
      if (!choice) throw new Error("No response from LLM");

      const assistantMsg = choice.message;
      if (!isRecord(assistantMsg)) {
        throw new Error(`LLM 响应格式异常: 缺少 message 字段 — ${JSON.stringify(data).slice(0, 200)}`);
      }
      if (assistantMsg.tool_calls !== undefined && !Array.isArray(assistantMsg.tool_calls)) {
        throw new Error("tool_calls must be an array");
      }

      // Has tool calls → execute and continue loop
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const tc of assistantMsg.tool_calls) {
          if (typeof tc.id !== "string" || tc.id.length === 0) throw new Error("tool_call missing id");
          if (typeof tc.function?.name !== "string" || tc.function.name.length === 0) throw new Error("tool_call missing name");
          if (typeof tc.function?.arguments !== "string") throw new Error("tool_call arguments must be a string");
        }

        history.push({
          role: "assistant",
          content: assistantMsg.content || "",
          tool_calls: assistantMsg.tool_calls,
        });

        // 通知前端正在调用工具
        if (onChunk) {
          const toolNames = assistantMsg.tool_calls.map((tc) => bindingByExposedName.get(tc.function.name)?.tool.name ?? tc.function.name).join(", ");
          onChunk(`\n\n> 🔧 调用工具: ${toolNames}\n\n`);
        }

        for (const tc of assistantMsg.tool_calls) {
          const args = readToolArguments(tc.function.arguments, "tool_call");
          let result: string;
          try {
            result = await callBoundTool(tc.function.name, args);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          history.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
        }
        continue;
      }

      // No tool calls → this is the final answer
      if (typeof assistantMsg.content !== "string") {
        throw new Error(`LLM 响应格式异常: 缺少 message.content 字段 — ${JSON.stringify(data).slice(0, 200)}`);
      }
      const content = assistantMsg.content;
      if (onChunk && content) onChunk(content);
      return {
        content,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

  }

  // ---- Agentic Loop: Anthropic ----

  private async agenticLoopAnthropic(
    messages: ChatMessage[],
    tools: MCPToolInfo[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk?: (chunk: string) => void,
    _maxRounds = 10,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const bindings = createToolBindings(tools);
    const bindingByExposedName = new Map(bindings.map((binding) => [binding.exposedName, binding]));
    const callBoundTool = (name: string, args: Record<string, unknown>): Promise<string> =>
      callTool(bindingByExposedName.get(name)?.tool.name ?? name, args);
    const anthropicTools = bindings.map((binding) => ({
      name: binding.exposedName,
      description: binding.tool.description,
      input_schema: binding.tool.inputSchema,
    }));

    const systemMsg = messages.find((m) => m.role === "system");
    // Anthropic message format: role is "user" | "assistant", content can be array
    const history: Array<{ role: string; content: string | AnthropicContentBlock[] | Array<{ type: string; tool_use_id?: string; content?: string }> }> = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (;;) {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
      const body: Record<string, unknown> = {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: history,
        tools: anthropicTools,
        stream: false,
      };
      if (systemMsg) body.system = systemMsg.content;

      signal?.throwIfAborted();
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(sanitizeForJson(body)),
      }, 1, false, signal);

      const data = await this.safeParseJson<{
        content: AnthropicContentBlock[];
        stop_reason: string;
        usage?: { input_tokens: number; output_tokens: number };
      }>(response);

      totalPromptTokens += data.usage?.input_tokens || 0;
      totalCompletionTokens += data.usage?.output_tokens || 0;

      if (!Array.isArray(data.content)) {
        throw new Error(`LLM 响应格式异常: 缺少 content 字段 — ${JSON.stringify(data).slice(0, 200)}`);
      }

      const toolUseBlocks = data.content.filter(
        (b): b is AnthropicToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length > 0) {
        for (const block of toolUseBlocks) {
          if (typeof block.id !== "string" || block.id.length === 0) throw new Error("tool_use missing id");
          if (typeof block.name !== "string" || block.name.length === 0) throw new Error("tool_use missing name");
          if (!isRecord(block.input)) throw new Error("tool_use input must be an object");
        }

        // Push assistant message with content blocks
        history.push({ role: "assistant", content: data.content });

        if (onChunk) {
          const toolNames = toolUseBlocks.map((b) => bindingByExposedName.get(b.name)?.tool.name ?? b.name).join(", ");
          onChunk(`\n\n> 🔧 调用工具: ${toolNames}\n\n`);
        }

        // Execute tools and push results
        const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
        for (const block of toolUseBlocks) {
          let result: string;
          try {
            result = await callBoundTool(block.name, block.input);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
        history.push({ role: "user", content: toolResults });
        continue;
      }

      // No tool use → extract text content as final answer
      const textContent = readAnthropicTextContent(data);
      if (onChunk && textContent) onChunk(textContent);
      return {
        content: textContent,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

  }

  // ---- Agentic Loop: OpenAI Responses API ----

  private async agenticLoopResponses(
    messages: ChatMessage[],
    tools: MCPToolInfo[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk?: (chunk: string) => void,
    _maxRounds = 10,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const bindings = createToolBindings(tools);
    const bindingByExposedName = new Map(bindings.map((binding) => [binding.exposedName, binding]));
    const callBoundTool = (name: string, args: Record<string, unknown>): Promise<string> =>
      callTool(bindingByExposedName.get(name)?.tool.name ?? name, args);
    const responsesTools = bindings.map((binding) => ({
      type: "function" as const,
      name: binding.exposedName,
      description: binding.tool.description,
      parameters: binding.tool.inputSchema,
      strict: false,
    }));

    const systemMsg = messages.find((m) => m.role === "system");
    const input: Array<Record<string, unknown>> = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (;;) {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/responses`;
      const body: Record<string, unknown> = {
        model: this.config.model,
        input,
        max_output_tokens: this.config.maxTokens,
        tools: responsesTools,
        stream: false,
      };
      if (systemMsg) body.instructions = systemMsg.content;

      signal?.throwIfAborted();
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(sanitizeForJson(body)),
      }, 1, false, signal);

      const data = await this.safeParseJson<{
        status?: string;
        incomplete_details?: ResponsesIncompleteDetails;
        error?: { message?: string };
        output: Array<ResponsesOutputItem & {
          id?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
        output_text?: string;
        usage?: { input_tokens: number; output_tokens: number };
      }>(response);

      totalPromptTokens += data.usage?.input_tokens || 0;
      totalCompletionTokens += data.usage?.output_tokens || 0;

      if (data.status === "incomplete") {
        throw new Error(`Responses API incomplete: ${data.incomplete_details?.reason || "unknown"}`);
      }
      if (data.status === "failed") {
        throw new Error(`Responses API failed: ${data.error?.message || "unknown"}`);
      }
      if (!Array.isArray(data.output)) {
        throw new Error(`LLM 响应格式异常: 缺少 output 字段 — ${JSON.stringify(data).slice(0, 200)}`);
      }

      const functionCalls = data.output.filter((item) => item.type === "function_call");

      if (functionCalls.length > 0) {
        for (const fc of functionCalls) {
          if (typeof fc.call_id !== "string" || fc.call_id.length === 0) throw new Error("function_call missing call_id");
          if (typeof fc.name !== "string" || fc.name.length === 0) throw new Error("function_call missing name");
          if (typeof fc.arguments !== "string") throw new Error("function_call arguments must be a string");
        }

        for (const item of data.output) {
          input.push(item as Record<string, unknown>);
        }

        if (onChunk) {
          const toolNames = functionCalls.map((fc) => bindingByExposedName.get(fc.name)?.tool.name ?? fc.name).join(", ");
          onChunk(`\n\n> 🔧 调用工具: ${toolNames}\n\n`);
        }

        for (const fc of functionCalls) {
          let result: string;
          const args = readToolArguments(fc.arguments, "function_call");
          try {
            result = await callBoundTool(fc.name, args);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          input.push({
            type: "function_call_output",
            call_id: fc.call_id,
            output: result,
          });
        }
        continue;
      }

      // No function calls → extract text
      const content = readResponsesOutputText(data);

      if (onChunk && content) onChunk(content);
      return {
        content,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

  }

  private async completeOpenAI(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const stream = !!onChunk;
    const body = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      stream,
    };

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(sanitizeForJson(body)),
    }, 1, stream, signal);

    if (stream) return this.parseOpenAIStream(response, onChunk!);

    const data = await this.safeParseJson<{
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }>(response);
    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error(`LLM 响应格式异常: 缺少 choices 字段 — ${JSON.stringify(data).slice(0, 200)}`);
    }
    const content = data.choices[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`LLM 响应格式异常: 缺少 message.content 字段 — ${JSON.stringify(data).slice(0, 200)}`);
    }
    return {
      content,
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    };
  }

  private async completeResponses(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/responses`;
    const stream = !!onChunk;
    const systemMsg = messages.find((m) => m.role === "system");
    const inputMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: inputMessages,
      max_output_tokens: this.config.maxTokens,
      stream,
    };
    if (systemMsg) body.instructions = systemMsg.content;

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(sanitizeForJson(body)),
    }, 1, stream, signal);

    if (stream) return this.parseResponsesStream(response, onChunk!);

    const data = await this.safeParseJson<{
      status?: string;
      incomplete_details?: ResponsesIncompleteDetails;
      error?: { message?: string };
      output_text?: string;
      output?: ResponsesOutputItem[];
      usage?: { input_tokens: number; output_tokens: number };
    }>(response);
    if (data.status === "incomplete") {
      throw new Error(`Responses API incomplete: ${data.incomplete_details?.reason || "unknown"}`);
    }
    if (data.status === "failed") {
      throw new Error(`Responses API failed: ${data.error?.message || "unknown"}`);
    }
    if (typeof data.output_text !== "string" && !Array.isArray(data.output)) {
      throw new Error(`LLM 响应格式异常: 缺少 output 字段 — ${JSON.stringify(data).slice(0, 200)}`);
    }
    const content = readResponsesOutputText(data);
    return {
      content,
      promptTokens: data.usage?.input_tokens || 0,
      completionTokens: data.usage?.output_tokens || 0,
    };
  }

  private async completeAnthropic(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
    const stream = !!onChunk;
    const systemMsg = messages.find((m) => m.role === "system");
    const userMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: userMessages,
      stream,
    };
    if (systemMsg) body.system = systemMsg.content;

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(sanitizeForJson(body)),
    }, 1, stream, signal);

    if (stream) return this.parseAnthropicStream(response, onChunk!);

    const data = await this.safeParseJson<{
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    }>(response);
    if (!Array.isArray(data.content)) {
      throw new Error(`LLM 响应格式异常: 缺少 content 字段 — ${JSON.stringify(data).slice(0, 200)}`);
    }
    const content = readAnthropicTextContent(data);
    return {
      content,
      promptTokens: data.usage?.input_tokens || 0,
      completionTokens: data.usage?.output_tokens || 0,
    };
  }

  private async parseOpenAIStream(
    response: Response,
    onChunk: (chunk: string) => void,
  ): Promise<LLMResponse> {
    let fullContent = "",
      promptTokens = 0,
      completionTokens = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) return;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      const parsed = parseStreamJson<any>(data, "OpenAI");
      if (parsed.error) {
        const errorMsg = parsed.error.message || "Unknown stream error";
        throw new Error(`OpenAI stream error: ${errorMsg}`);
      }
      const chunk = readStreamTextDelta(parsed.choices?.[0]?.delta?.content, "OpenAI", "delta.content");
      if (chunk) {
        fullContent += chunk;
        onChunk(chunk);
      }
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens;
        completionTokens = parsed.usage.completion_tokens;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    if (buffer) processLine(buffer);
    return { content: requireLLMContent(fullContent, "message.content"), promptTokens, completionTokens };
  }

  private async parseResponsesStream(
    response: Response,
    onChunk: (chunk: string) => void,
  ): Promise<LLMResponse> {
    let fullContent = "",
      promptTokens = 0,
      completionTokens = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) {
        currentEvent = "";
        return;
      }
      if (trimmed.startsWith("event: ")) {
        currentEvent = trimmed.slice(7);
        return;
      }
      if (!trimmed.startsWith("data: ")) return;
      const parsed = parseStreamJson<any>(trimmed.slice(6), "Responses API");
      if (currentEvent === "response.output_text.delta") {
        const delta = readStreamTextDelta(parsed.delta, "Responses API", "delta", true);
        if (delta) {
          fullContent += delta;
          onChunk(delta);
        }
      }
      if (currentEvent === "response.completed" && parsed.response?.usage) {
        promptTokens = parsed.response.usage.input_tokens || 0;
        completionTokens = parsed.response.usage.output_tokens || 0;
      }
      if (currentEvent === "response.incomplete") {
        const reason = parsed.response?.incomplete_details?.reason || "unknown";
        throw new Error(`Responses API incomplete: ${reason}`);
      }
      if (currentEvent === "error" || currentEvent === "response.failed") {
        const errorMsg =
          parsed.message ||
          parsed.error?.message ||
          parsed.response?.error?.message ||
          "Unknown stream error";
        throw new Error(`Responses API stream error: ${errorMsg}`);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    if (buffer) processLine(buffer);
    return { content: requireLLMContent(fullContent, "output_text"), promptTokens, completionTokens };
  }

  private async parseAnthropicStream(
    response: Response,
    onChunk: (chunk: string) => void,
  ): Promise<LLMResponse> {
    let fullContent = "",
      promptTokens = 0,
      completionTokens = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) return;
      const parsed = parseStreamJson<any>(trimmed.slice(6), "Anthropic");
      if (parsed.type === "error") {
        const errorMsg = parsed.error?.message || "Unknown stream error";
        throw new Error(`Anthropic stream error: ${errorMsg}`);
      }
      if (parsed.type === "content_block_delta") {
        const delta = readStreamTextDelta(parsed.delta?.text, "Anthropic", "delta.text");
        if (delta) {
          fullContent += delta;
          onChunk(delta);
        }
      }
      if (parsed.type === "message_start" && parsed.message?.usage)
        promptTokens = parsed.message.usage.input_tokens;
      if (parsed.type === "message_delta" && parsed.usage)
        completionTokens = parsed.usage.output_tokens || 0;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    if (buffer) processLine(buffer);
    return { content: requireLLMContent(fullContent, "text content"), promptTokens, completionTokens };
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = 1,
    isStreaming = false,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let abortedBySignal = false;
    const abortFromSignal = (): void => {
      abortedBySignal = true;
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) abortFromSignal();
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    const startTime = Date.now();

    // Extract headers for logging
    const rawHeaders: Record<string, string> = {};
    if (options.headers) {
      const h = options.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) rawHeaders[k] = v;
    }
    const maskedHeaders = maskSensitiveHeaders(rawHeaders);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 429 && retries > 0) {
        const retryAfter = parseInt(
          response.headers.get("retry-after") || "5",
          10,
        );
        await delayWithAbort(retryAfter * 1000, signal);
        return this.fetchWithRetry(url, options, retries - 1, isStreaming, signal);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const host = (() => { try { return new URL(url).host; } catch { return url; } })();
        const durationMs = Date.now() - startTime;

        // Log failed request
        this.onRequestComplete?.({
          request_url: url,
          request_method: (options.method ?? 'POST').toUpperCase(),
          request_headers: JSON.stringify(maskedHeaders),
          request_body: typeof options.body === 'string' ? options.body : '',
          status_code: response.status,
          response_headers: JSON.stringify(Object.fromEntries(response.headers.entries())),
          response_body: errorBody.slice(0, 10000),
          duration_ms: durationMs,
          error: `${response.status} ${errorBody.slice(0, 200)}`,
        });

        throw new Error(`LLM 请求失败 (${host}): ${response.status} ${errorBody.slice(0, 200)}`);
      }

      // Success path
      const durationMs = Date.now() - startTime;
      const responseHeadersObj = Object.fromEntries(response.headers.entries());

      if (isStreaming) {
        // Streaming: cannot read body, mark as [streaming]
        this.onRequestComplete?.({
          request_url: url,
          request_method: (options.method ?? 'POST').toUpperCase(),
          request_headers: JSON.stringify(maskedHeaders),
          request_body: typeof options.body === 'string' ? options.body : '',
          status_code: response.status,
          response_headers: JSON.stringify(responseHeadersObj),
          response_body: '[streaming]',
          duration_ms: durationMs,
          error: null,
        });
        return response;
      }

      // Non-streaming: read body, log, then reconstruct Response
      const responseText = await response.text();
      this.onRequestComplete?.({
        request_url: url,
        request_method: (options.method ?? 'POST').toUpperCase(),
        request_headers: JSON.stringify(maskedHeaders),
        request_body: typeof options.body === 'string' ? options.body : '',
        status_code: response.status,
        response_headers: JSON.stringify(responseHeadersObj),
        response_body: responseText.slice(0, 100000),
        duration_ms: durationMs,
        error: null,
      });

      return new Response(responseText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

    } catch (err) {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;

      if (err instanceof Error && err.message.startsWith('LLM 请求失败')) {
        throw err;  // Already logged above
      }

      // Network-level error — log it
      const diagMsg = abortedBySignal
        ? "LLM 请求已取消"
        : this.diagnoseNetworkError(err as Error, url);
      this.onRequestComplete?.({
        request_url: url,
        request_method: (options.method ?? 'POST').toUpperCase(),
        request_headers: JSON.stringify(maskedHeaders),
        request_body: typeof options.body === 'string' ? options.body : '',
        status_code: null,
        response_headers: null,
        response_body: null,
        duration_ms: durationMs,
        error: diagMsg,
      });

      throw new Error(diagMsg);
    } finally {
      signal?.removeEventListener("abort", abortFromSignal);
    }
  }

  /**
   * 将底层网络错误转换为用户可理解的诊断信息。
   */
  private diagnoseNetworkError(err: Error, url: string): string {
    // Node.js 18+ wraps the real error in err.cause — extract it for better diagnosis
    const cause = (err as any).cause;
    const msg = [err.message, cause?.message, cause?.code].filter(Boolean).join(' | ');
    const host = (() => {
      try { return new URL(url).host; } catch { return url; }
    })();

    // AbortController timeout
    if (err.name === "AbortError" || msg.includes("aborted")) {
      return `连接超时：${host} 在 ${DEFAULT_TIMEOUT / 1000} 秒内未响应。请检查 API 地址是否正确，以及网络是否可达。`;
    }

    // DNS resolution failure
    if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
      return `DNS 解析失败：无法解析 ${host}。请检查 API 地址拼写是否正确。`;
    }

    // Connection refused (local service not running)
    if (msg.includes("ECONNREFUSED")) {
      return `连接被拒绝：${host} 未在监听。如果使用本地中转服务，请确认该服务已启动。`;
    }

    // Connection reset
    if (msg.includes("ECONNRESET") || msg.includes("socket hang up")) {
      return `连接被重置：${host} 中断了连接。可能是代理服务器不稳定或 API 服务限流。`;
    }

    // SSL/TLS errors
    if (msg.includes("UNABLE_TO_VERIFY") || msg.includes("CERT_") || msg.includes("certificate") || msg.includes("SSL")) {
      return `SSL 证书错误：无法与 ${host} 建立安全连接。如果使用自签证书的中转服务，需配置 NODE_TLS_REJECT_UNAUTHORIZED=0 环境变量（不推荐用于生产环境）。`;
    }

    // Network unreachable
    if (msg.includes("ENETUNREACH") || msg.includes("EHOSTUNREACH")) {
      return `网络不可达：无法连接到 ${host}。请检查网络连接。`;
    }

    // Generic "fetch failed" — the most common opaque error
    if (msg.includes("fetch failed")) {
      const causeDetail = cause ? ` (${cause.code || cause.message || cause})` : '';
      return `网络请求失败：无法连接到 ${host}${causeDetail}。常见原因：1) API 地址配置错误 2) 网络无法访问该地址（如需科学上网） 3) 本地中转服务未启动。`;
    }

    // Fallback: preserve original message
    return `LLM 请求失败 (${host}): ${msg}`;
  }
}
