export const DEFAULT_CHAT_CONTEXT_CHARS = 60_000;
export const KEEP_RECENT_TOOL_CONTEXTS = 2;

interface MessageLike {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

function compactText(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.ceil(maxChars * 0.7);
  const tailChars = Math.max(0, maxChars - headChars);
  const compacted = `${content.slice(0, headChars)}\n...(上下文已压缩，共 ${content.length} 字符)\n${content.slice(-tailChars)}`;
  return compacted.slice(0, maxChars);
}

function stripToolContext(content: string): string {
  return content.replace(/\n*<tool_context>[\s\S]*?<\/tool_context>\s*$/g, '');
}

export function compactChatMessages(input: MessageLike[], maxChars = DEFAULT_CHAT_CONTEXT_CHARS): MessageLike[] {
  const messages = input.map((message) => ({ ...message }));
  let assistantCount = 0;
  for (let index = messages.length - 1; index >= 2; index -= 1) {
    if (messages[index].role !== 'assistant') continue;
    assistantCount += 1;
    if (assistantCount > KEEP_RECENT_TOOL_CONTEXTS) {
      messages[index].content = stripToolContext(messages[index].content);
    }
  }

  const contentLength = () => messages.reduce((sum, message) => sum + message.content.length, 0);
  if (contentLength() <= maxChars) return messages;

  if (messages[0]) messages[0].content = compactText(messages[0].content, 8_000);
  if (messages[1]) messages[1].content = compactText(messages[1].content, 28_000);
  for (let index = 2; index < messages.length; index += 1) {
    messages[index].content = compactText(messages[index].content, index >= messages.length - 4 ? 8_000 : 2_000);
  }

  while (contentLength() > maxChars && messages.length > 2) {
    const oldestIndex = messages.length > 3 ? 2 : 1;
    const message = messages[oldestIndex];
    if (!message) break;
    const overflow = contentLength() - maxChars;
    const nextLength = Math.max(100, message.content.length - overflow);
    const compacted = compactText(message.content, nextLength);
    if (compacted.length >= message.content.length) {
      messages.splice(oldestIndex, 1);
    } else {
      message.content = compacted;
    }
  }
  return messages;
}
