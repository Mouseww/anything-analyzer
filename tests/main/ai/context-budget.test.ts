import { describe, expect, it } from "vitest";
import { compactChatMessages } from "../../../src/main/ai/context-budget";

describe("context budget", () => {
  it("compacts oversized follow-up history without an extra LLM request", () => {
    const history = [
      { role: "system", content: "system" },
      { role: "assistant", content: "report-".repeat(20_000) },
      { role: "user", content: "请检查请求 #1" },
      { role: "assistant", content: "answer-".repeat(5_000) + "\n<tool_context>large detail</tool_context>" },
      { role: "user", content: "继续检查" },
    ];

    const compacted = compactChatMessages(history, 4_000);

    expect(compacted.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(4_000);
    expect(compacted.some((message) => message.content.includes("继续检查"))).toBe(true);
    expect(compacted.map((message) => message.content).join("\n")).not.toContain("<tool_context>large detail</tool_context>");
  });


});
