import type { LLMProviderConfig } from "@shared/types";
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
 * LLMRouter — Unified interface for calling different LLM providers.
 * Supports OpenAI, Anthropic, and OpenAI-compatible APIs.
 */
export class LLMRouter {
  constructor(private config: LLMProviderConfig) {}

  async complete(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<LLMResponse> {
    if (this.config.name === "anthropic" || this.config.name === "minimax") {
      return this.completeAnthropic(messages, onChunk);
    }
    if (this.config.apiType === "responses") {
      return this.completeResponses(messages, onChunk);
    }
    return this.completeOpenAI(messages, onChunk);
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
    maxRounds = 10,
  ): Promise<LLMResponse> {
    if (this.config.name === "anthropic" || this.config.name === "minimax") {
      return this.agenticLoopAnthropic(messages, tools, callTool, onChunk, maxRounds);
    }
    return this.agenticLoopOpenAI(messages, tools, callTool, onChunk, maxRounds);
  }

  // ---- Agentic Loop: OpenAI / Custom ----

  private async agenticLoopOpenAI(
    messages: ChatMessage[],
    tools: MCPToolInfo[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk?: (chunk: string) => void,
    maxRounds = 10,
  ): Promise<LLMResponse> {
    const openaiTools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const history = [...messages];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (let round = 0; round < maxRounds; round++) {
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

      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(sanitizeForJson(body)),
      });

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: ToolCall[];
            role: string;
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      totalPromptTokens += data.usage?.prompt_tokens || 0;
      totalCompletionTokens += data.usage?.completion_tokens || 0;

      const choice = data.choices[0];
      if (!choice) throw new Error("No response from LLM");

      const assistantMsg = choice.message;

      // Has tool calls → execute and continue loop
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        history.push({
          role: "assistant",
          content: assistantMsg.content || "",
          tool_calls: assistantMsg.tool_calls,
        });

        // 通知前端正在调用工具
        if (onChunk) {
          const toolNames = assistantMsg.tool_calls.map((tc) => tc.function.name).join(", ");
          onChunk(`\n\n> 🔧 调用工具: ${toolNames}\n\n`);
        }

        for (const tc of assistantMsg.tool_calls) {
          let result: string;
          try {
            const args = JSON.parse(tc.function.arguments);
            result = await callTool(tc.function.name, args);
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
      const content = assistantMsg.content || "";
      if (onChunk && content) onChunk(content);
      return {
        content,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

    // Max rounds exceeded — do final call without tools to force text response
    return this.complete(history, onChunk);
  }

  // ---- Agentic Loop: Anthropic ----

  private async agenticLoopAnthropic(
    messages: ChatMessage[],
    tools: MCPToolInfo[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk?: (chunk: string) => void,
    maxRounds = 10,
  ): Promise<LLMResponse> {
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    const systemMsg = messages.find((m) => m.role === "system");
    // Anthropic message format: role is "user" | "assistant", content can be array
    const history: Array<{ role: string; content: string | AnthropicContentBlock[] | Array<{ type: string; tool_use_id?: string; content?: string }> }> = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (let round = 0; round < maxRounds; round++) {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
      const body: Record<string, unknown> = {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: history,
        tools: anthropicTools,
        stream: false,
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
      });

      const data = (await response.json()) as {
        content: AnthropicContentBlock[];
        stop_reason: string;
        usage?: { input_tokens: number; output_tokens: number };
      };

      totalPromptTokens += data.usage?.input_tokens || 0;
      totalCompletionTokens += data.usage?.output_tokens || 0;

      const toolUseBlocks = data.content.filter(
        (b): b is AnthropicToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length > 0) {
        // Push assistant message with content blocks
        history.push({ role: "assistant", content: data.content });

        if (onChunk) {
          const toolNames = toolUseBlocks.map((b) => b.name).join(", ");
          onChunk(`\n\n> 🔧 调用工具: ${toolNames}\n\n`);
        }

        // Execute tools and push results
        const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
        for (const block of toolUseBlocks) {
          let result: string;
          try {
            result = await callTool(block.name, block.input);
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
      const textContent = data.content
        .filter((b): b is AnthropicTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      if (onChunk && textContent) onChunk(textContent);
      return {
        content: textContent,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

    // Max rounds exceeded — final call without tools
    return this.complete(messages, onChunk);
  }

  private async completeOpenAI(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
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
    });

    if (stream) return this.parseOpenAIStream(response, onChunk!);

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: data.choices[0]?.message?.content || "",
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    };
  }

  private async completeResponses(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
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
    });

    if (stream) return this.parseResponsesStream(response, onChunk!);

    const data = (await response.json()) as {
      output_text?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };
    return {
      content: data.output_text || "",
      promptTokens: data.usage?.input_tokens || 0,
      completionTokens: data.usage?.output_tokens || 0,
    };
  }

  private async completeAnthropic(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
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
    });

    if (stream) return this.parseAnthropicStream(response, onChunk!);

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const content = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as any;
          const chunk = parsed.choices?.[0]?.delta?.content || "";
          if (chunk) {
            fullContent += chunk;
            onChunk(chunk);
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens;
            completionTokens = parsed.usage.completion_tokens;
          }
        } catch {
          /* skip */
        }
      }
    }
    return { content: fullContent, promptTokens, completionTokens };
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          currentEvent = "";
          continue;
        }
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
          continue;
        }
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as any;
          if (currentEvent === "response.output_text.delta" && parsed.delta) {
            fullContent += parsed.delta;
            onChunk(parsed.delta);
          }
          if (currentEvent === "response.completed" && parsed.response?.usage) {
            promptTokens = parsed.response.usage.input_tokens || 0;
            completionTokens = parsed.response.usage.output_tokens || 0;
          }
          if (currentEvent === "error" || currentEvent === "response.failed") {
            const errorMsg =
              parsed.message || parsed.error?.message || "Unknown stream error";
            throw new Error(`Responses API stream error: ${errorMsg}`);
          }
        } catch {
          /* skip malformed JSON */
        }
      }
    }
    return { content: fullContent, promptTokens, completionTokens };
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as any;
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            fullContent += parsed.delta.text;
            onChunk(parsed.delta.text);
          }
          if (parsed.type === "message_start" && parsed.message?.usage)
            promptTokens = parsed.message.usage.input_tokens;
          if (parsed.type === "message_delta" && parsed.usage)
            completionTokens = parsed.usage.output_tokens || 0;
        } catch {
          /* skip */
        }
      }
    }
    return { content: fullContent, promptTokens, completionTokens };
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = 1,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      // Clear timeout once we get the response headers — streaming can take much longer
      clearTimeout(timeout);
      if (response.status === 429 && retries > 0) {
        const retryAfter = parseInt(
          response.headers.get("retry-after") || "5",
          10,
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        return this.fetchWithRetry(url, options, retries - 1);
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`LLM API error ${response.status}: ${errorBody}`);
      }
      return response;
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(this.diagnoseNetworkError(err as Error, url));
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
