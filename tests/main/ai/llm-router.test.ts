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
    vi.restoreAllMocks();
  });

  describe("routing", () => {
    it("should route minimax to Anthropic messages endpoint", async () => {
      const config: LLMProviderConfig = {
        name: "minimax",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKey: "test-minimax-key",
        model: "MiniMax-M2.7",
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
        model: "MiniMax-M2.7",
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
  });
});
