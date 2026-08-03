import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMRouter } from "../../../src/main/ai/llm-router";
import type { LLMProviderConfig } from "../../../src/shared/types";

// Helper: create a mock Response with SSE stream
function createSSEResponse(
  events: Array<{ event?: string; data: string }>,
): Response {
  const lines =
    events
      .map((e) => {
        const parts: string[] = [];
        if (e.event) parts.push(`event: ${e.event}`);
        parts.push(`data: ${e.data}`);
        return parts.join("\n");
      })
      .join("\n\n") + "\n\n";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createRawSSEResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// Helper: create a mock JSON Response
function createJSONResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const baseConfig: LLMProviderConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxTokens: 4096,
};

describe("LLMRouter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("routing", () => {
    it("should abort while waiting to retry rate-limited requests", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      fetchSpy.mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "60" },
        }),
      );

      const router = new LLMRouter(baseConfig);
      const request = router.complete(
        [{ role: "user", content: "test" }],
        undefined,
        controller.signal,
      );
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      controller.abort();

      await expect(request).rejects.toThrow("LLM 请求已取消");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("should connect abort signal to standard LLM requests", async () => {
      const controller = new AbortController();
      fetchSpy.mockImplementationOnce((_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const router = new LLMRouter(baseConfig);
      const request = router.complete([{ role: "user", content: "test" }], undefined, controller.signal);

      const [, options] = fetchSpy.mock.calls[0];
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      await expect(request).rejects.toThrow("LLM 请求已取消");
    });

    it("should connect abort signal to tool-enabled LLM requests", async () => {
      const controller = new AbortController();
      fetchSpy.mockImplementationOnce((_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const router = new LLMRouter(baseConfig);
      const request = router.completeWithTools(
        [{ role: "user", content: "test" }],
        [],
        async () => "unused",
        undefined,
        1,
        controller.signal,
      );

      const [, options] = fetchSpy.mock.calls[0];
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      await expect(request).rejects.toThrow("LLM 请求已取消");
    });

    it("should route minimax to Anthropic messages endpoint", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M3",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "text", text: "hello from MiniMax" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "test" }]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.minimax.io/anthropic/v1/messages");
    });

    it("should use x-api-key header for minimax", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M3",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "test" }]);

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers["x-api-key"]).toBe("test-minimax-key");
      expect(options.headers).not.toHaveProperty("Authorization");
    });

    it("should parse MiniMax response content and usage correctly", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "text", text: "MiniMax response" }],
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
      );

      const router = new LLMRouter(config);
      const result = await router.complete([{ role: "user", content: "hello" }]);

      expect(result.content).toBe("MiniMax response");
      expect(result.promptTokens).toBe(20);
      expect(result.completionTokens).toBe(10);
    });

    it("should reject Anthropic-compatible responses without text content", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", id: "call-1", name: "lookup", input: {} }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 text content 字段");
    });

    it("should reject Anthropic-compatible responses with non-string text content", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "text", text: { value: "not a string" } }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("LLM 响应格式异常: text content 必须是字符串");
    });

    it("should route to completions endpoint when apiType is undefined", async () => {
      const config: LLMProviderConfig = { ...baseConfig };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "test" }]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it('should route to completions endpoint when apiType is "completions"', async () => {
      const config: LLMProviderConfig = {
        ...baseConfig,
        apiType: "completions",
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "test" }]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("should reject malformed OpenAI completion responses", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          id: "chatcmpl-test",
          object: "chat.completion",
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 choices 字段");
    });

    it("should reject non-object OpenAI completion JSON with a clear format error", async () => {
      fetchSpy.mockResolvedValueOnce(createJSONResponse(null));

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 choices 字段");
    });

    it("should reject OpenAI completion choices without message content", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [{ message: {} }],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 message.content 字段");
    });

    it('should route to responses endpoint when apiType is "responses"', async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output_text: "hello",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "test" }]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/responses");
    });
  });

  describe("completeResponses - request body", () => {
    it("should extract system message as instructions field", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output_text: "result",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ]);

      const [, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.instructions).toBe("You are a helpful assistant");
      expect(body.input).toEqual([{ role: "user", content: "Hello" }]);
      expect(body.model).toBe("gpt-4o");
      expect(body.max_output_tokens).toBe(4096);
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("messages");
    });

    it("should omit instructions when no system message", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output_text: "result",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "Hello" }]);

      const [, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body).not.toHaveProperty("instructions");
      expect(body.input).toEqual([{ role: "user", content: "Hello" }]);
    });
  });

  describe("completeResponses - non-streaming", () => {
    it("should parse output_text and usage from response", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output_text: "# Report\nContent here",
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
      );

      const router = new LLMRouter(config);
      const result = await router.complete([{ role: "user", content: "test" }]);

      expect(result.content).toBe("# Report\nContent here");
      expect(result.promptTokens).toBe(100);
      expect(result.completionTokens).toBe(200);
    });

    it("should parse message output when output_text is omitted", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "# Report\n" },
                { type: "output_text", text: "Content from output" },
              ],
            },
          ],
          usage: { input_tokens: 30, output_tokens: 40 },
        }),
      );

      const router = new LLMRouter(config);
      const result = await router.complete([{ role: "user", content: "test" }]);

      expect(result.content).toBe("# Report\nContent from output");
      expect(result.promptTokens).toBe(30);
      expect(result.completionTokens).toBe(40);
    });

    it("should reject malformed Responses API results", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          id: "resp-test",
          status: "completed",
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 output 字段");
    });

    it("should reject Responses API results without output text", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          status: "completed",
          output: [],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 output_text 字段");
    });

    it("should reject incomplete Responses API results", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output_text: "partial",
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("Responses API incomplete: max_output_tokens");
    });

    it("should reject failed Responses API results", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          status: "failed",
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }]),
      ).rejects.toThrow("Responses API failed: unknown");
    });
  });

  it("normalizes tool names for compatible providers and routes back to the original name", async () => {
    const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
    fetchSpy.mockResolvedValueOnce(
      createJSONResponse({
        output: [{ type: "function_call", call_id: "call-1", name: "get_page", arguments: "{}" }],
      }),
    ).mockResolvedValueOnce(
      createJSONResponse({
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      }),
    );

    const calledNames: string[] = [];
    const router = new LLMRouter(config);
    await router.completeWithTools(
      [{ role: "user", content: "test" }],
      [
        { name: "get.page", description: "Get page", inputSchema: { type: "object" } },
        { name: "lookup", description: "First lookup", inputSchema: { type: "object" } },
        { name: "lookup", description: "Second lookup", inputSchema: { type: "object" } },
      ],
      async (name) => {
        calledNames.push(name);
        return "tool result";
      },
    );

    const [, firstOptions] = fetchSpy.mock.calls[0];
    const firstBody = JSON.parse(firstOptions.body);
    expect(firstBody.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "get_page",
      "lookup",
      "lookup_2",
    ]);
    expect(firstBody.tools.every((tool: { strict: boolean }) => tool.strict === false)).toBe(true);
    expect(calledNames).toEqual(["get.page"]);
  });
  describe("completeWithTools - Responses API", () => {
    it("should reject failed Responses API tool rounds explicitly", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          status: "failed",
          error: { message: "tool planning failed" },
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [],
          async () => "unused",
        ),
      ).rejects.toThrow("Responses API failed: tool planning failed");
    });

    it("should reject incomplete Responses API tool rounds explicitly", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [],
          async () => "unused",
        ),
      ).rejects.toThrow("Responses API incomplete: max_output_tokens");
    });

    it("should reject Responses API function calls without call id", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [{ type: "function_call", name: "lookup", arguments: "{}" }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("function_call missing call_id");
    });

    it("should reject Responses API function calls with non-string names", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: 123,
              arguments: "{}",
            },
          ],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("function_call missing name");
    });

    it("should use Responses API call_id when returning function outputs", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "lookup",
              arguments: "{}",
            },
          ],
        }),
      ).mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
        }),
      );

      const router = new LLMRouter(config);
      await router.completeWithTools(
        [{ role: "user", content: "test" }],
        [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
        async () => "tool result",
      );

      const [, secondOptions] = fetchSpy.mock.calls[1];
      const secondBody = JSON.parse(secondOptions.body);
      expect(secondBody.input).toContainEqual({
        type: "function_call_output",
        call_id: "call-1",
        output: "tool result",
      });
    });

    it("should reject Responses API function calls with non-string arguments", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "lookup",
              arguments: { query: "test" },
            },
          ],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("function_call arguments must be a string");
    });

    it("should reject Responses API function calls with malformed JSON arguments", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "lookup",
              arguments: "{",
            },
          ],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("function_call arguments must be a valid JSON object");
    });

    it("should reject Responses API function calls with empty arguments", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "lookup",
              arguments: "",
            },
          ],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("function_call arguments must be a valid JSON object");
    });

    it("should validate Responses API function calls before streaming tool status", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      const chunks: string[] = [];
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          output: [
            {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              arguments: "{}",
            },
          ],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
          (chunk) => chunks.push(chunk),
        ),
      ).rejects.toThrow("function_call missing name");
      expect(chunks).toEqual([]);
    });
  });

  describe("completeWithTools - OpenAI", () => {
    it("should reject OpenAI tool rounds without assistant messages", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [{ finish_reason: "tool_calls" }],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 message 字段");
    });

    it("should reject OpenAI tool calls when tool_calls is not an array", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: { id: "call-1" },
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_calls must be an array");
    });

    it("should reject OpenAI tool calls without ids", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_call missing id");
    });

    it("should reject OpenAI tool calls with non-string ids", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 123,
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_call missing id");
    });

    it("should reject OpenAI tool calls without function names", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_call missing name");
    });

    it("should validate OpenAI tool calls before streaming tool status", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
          () => undefined,
        ),
      ).rejects.toThrow("tool_call missing name");
    });

    it("should reject OpenAI tool calls with non-string arguments", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: { query: "test" } },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_call arguments must be a string");
    });

    it("should reject OpenAI tool calls with malformed JSON arguments", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: "{" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_call arguments must be a valid JSON object");
    });

    it("should reject OpenAI tool calls with empty arguments", async () => {
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: "" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "test" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_call arguments must be a valid JSON object");
    });
  });

  describe("completeWithTools - Anthropic", () => {
    it("should reject Anthropic tool uses without id", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", name: "lookup", input: {} }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "hello" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_use missing id");
    });

    it("should reject Anthropic tool uses without name", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", id: "call-1", input: {} }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "hello" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_use missing name");
    });

    it("should reject Anthropic tool uses with non-string ids", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", id: 123, name: "lookup", input: {} }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "hello" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_use missing id");
    });

    it("should reject Anthropic tool uses with non-object input", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", id: "call-1", name: "lookup", input: "query=test" }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "hello" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
        ),
      ).rejects.toThrow("tool_use input must be an object");
    });

    it("should validate Anthropic tool uses before streaming tool status", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      const chunks: string[] = [];
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", id: "call-1", input: {} }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "hello" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "unused",
          (chunk) => chunks.push(chunk),
        ),
      ).rejects.toThrow("tool_use missing name");
      expect(chunks).toEqual([]);
    });

    it("should reject final Anthropic tool loop responses without text content", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7-highspeed",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "tool_use", id: "call-1", name: "lookup", input: {} }],
        }),
      ).mockResolvedValueOnce(
        createJSONResponse({
          content: [{ type: "thinking", text: "internal" }],
        }),
      );

      const router = new LLMRouter(config);

      await expect(
        router.completeWithTools(
          [{ role: "user", content: "hello" }],
          [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          async () => "tool result",
        ),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 text content 字段");
    });
  });

  describe("completeResponses - streaming", () => {
    it("should parse SSE events with event: prefix and call onChunk", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          { event: "response.output_text.delta", data: '{"delta":"Hello "}' },
          { event: "response.output_text.delta", data: '{"delta":"world"}' },
          {
            event: "response.completed",
            data: '{"response":{"usage":{"input_tokens":50,"output_tokens":30}}}',
          },
        ]),
      );

      const router = new LLMRouter(config);
      const chunks: string[] = [];
      const result = await router.complete(
        [{ role: "user", content: "test" }],
        (chunk) => chunks.push(chunk),
      );

      expect(chunks).toEqual(["Hello ", "world"]);
      expect(result.content).toBe("Hello world");
      expect(result.promptTokens).toBe(50);
      expect(result.completionTokens).toBe(30);
    });

    it("should set stream: true in request body when onChunk provided", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          { event: "response.output_text.delta", data: '{"delta":"Hi"}' },
          {
            event: "response.completed",
            data: '{"response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
          },
        ]),
      );

      const router = new LLMRouter(config);
      await router.complete([{ role: "user", content: "test" }], () => {});

      const [, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.stream).toBe(true);
    });

    it("should parse the final SSE line when the stream has no trailing newline", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createRawSSEResponse(
          [
            'event: response.output_text.delta',
            'data: {"delta":"final chunk"}',
          ].join("\n"),
        ),
      );

      const router = new LLMRouter(config);
      const chunks: string[] = [];
      const result = await router.complete(
        [{ role: "user", content: "test" }],
        (chunk) => chunks.push(chunk),
      );

      expect(chunks).toEqual(["final chunk"]);
      expect(result.content).toBe("final chunk");
    });

    it("should reject when Responses API stream emits a failure event", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            event: "response.failed",
            data: '{"error":{"message":"rate limit exceeded"}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Responses API stream error: rate limit exceeded");
    });

    it("should read nested Responses API stream failure messages", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            event: "response.failed",
            data: '{"response":{"error":{"message":"model overloaded"}}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Responses API stream error: model overloaded");
    });

    it("should reject when Responses API stream emits an incomplete event", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            event: "response.incomplete",
            data: '{"response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Responses API incomplete: max_output_tokens");
    });

    it("should reject completed Responses API streams without output text", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            event: "response.completed",
            data: '{"response":{"usage":{"input_tokens":1,"output_tokens":0}}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 output_text 字段");
    });

    it("should reject malformed Responses API stream JSON", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createRawSSEResponse(
          [
            "event: response.output_text.delta",
            'data: {"delta":"broken"',
          ].join("\n"),
        ),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Responses API stream error: malformed JSON payload");
    });

    it("should reject non-string Responses API stream deltas", async () => {
      const config: LLMProviderConfig = { ...baseConfig, apiType: "responses" };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            event: "response.output_text.delta",
            data: '{"delta":{"text":"not a string"}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Responses API stream error: delta must be a string");
    });
  });

  describe("completeOpenAI - streaming", () => {
    it("should parse the final SSE line when the stream has no trailing newline", async () => {
      fetchSpy.mockResolvedValueOnce(
        createRawSSEResponse(
          [
            'data: {"choices":[{"delta":{"content":"final chat chunk"}}]}',
          ].join("\n"),
        ),
      );

      const router = new LLMRouter(baseConfig);
      const chunks: string[] = [];
      const result = await router.complete(
        [{ role: "user", content: "test" }],
        (chunk) => chunks.push(chunk),
      );

      expect(chunks).toEqual(["final chat chunk"]);
      expect(result.content).toBe("final chat chunk");
    });

    it("should reject when OpenAI chat stream emits an error payload", async () => {
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            data: '{"error":{"message":"quota exceeded"}}',
          },
        ]),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("OpenAI stream error: quota exceeded");
    });

    it("should reject completed OpenAI chat streams without content", async () => {
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            data: '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":0}}',
          },
          { data: "[DONE]" },
        ]),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 message.content 字段");
    });

    it("should reject malformed OpenAI chat stream JSON", async () => {
      fetchSpy.mockResolvedValueOnce(
        createRawSSEResponse('data: {"choices":[{"delta":{"content":"broken"}}'),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("OpenAI stream error: malformed JSON payload");
    });

    it("should reject non-string OpenAI chat stream deltas", async () => {
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            data: '{"choices":[{"delta":{"content":{"text":"not a string"}}}]}',
          },
        ]),
      );

      const router = new LLMRouter(baseConfig);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("OpenAI stream error: delta.content must be a string");
    });
  });

  describe("completeAnthropic - streaming", () => {
    it("should reject when Anthropic stream emits an error payload", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M3",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            data: '{"type":"error","error":{"message":"overloaded"}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Anthropic stream error: overloaded");
    });

    it("should parse the final SSE line when the stream has no trailing newline", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M3",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createRawSSEResponse(
          [
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"final anthropic chunk"}}',
          ].join("\n"),
        ),
      );

      const router = new LLMRouter(config);
      const chunks: string[] = [];
      const result = await router.complete(
        [{ role: "user", content: "test" }],
        (chunk) => chunks.push(chunk),
      );

      expect(chunks).toEqual(["final anthropic chunk"]);
      expect(result.content).toBe("final anthropic chunk");
    });

    it("should reject completed Anthropic streams without text content", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            data: '{"type":"message_delta","usage":{"output_tokens":0}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("LLM 响应格式异常: 缺少 text content 字段");
    });

    it("should reject malformed Anthropic stream JSON", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createRawSSEResponse('data: {"type":"content_block_delta","delta":{"text":"broken"}'),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Anthropic stream error: malformed JSON payload");
    });

    it("should reject non-string Anthropic stream deltas", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7",
        maxTokens: 4096,
      };
      fetchSpy.mockResolvedValueOnce(
        createSSEResponse([
          {
            data: '{"type":"content_block_delta","delta":{"text":{"value":"not a string"}}}',
          },
        ]),
      );

      const router = new LLMRouter(config);

      await expect(
        router.complete([{ role: "user", content: "test" }], () => {}),
      ).rejects.toThrow("Anthropic stream error: delta.text must be a string");
    });
  });
});
