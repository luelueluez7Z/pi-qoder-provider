import { createHash } from "node:crypto";
import type { transformMessagesForQoder } from "./transform.js";

const SUMMARY_INSTRUCTIONS = [
  ["detailed-summary", /(?:create|provide|write) a (?:detailed|comprehensive) summary/i],
  ["summarize-conversation", /summari[sz]e (?:this|the|our) (?:conversation|session)/i],
  ["summary-format", /(?:include|provide|output|wrap)[\s\S]{0,80}<summary>/i],
  ["chinese-summary", /(?:请|需要|任务是)[\s\S]{0,30}(?:总结|概括|摘要)[\s\S]{0,30}(?:对话|会话|上下文)/],
] as const;

/** No prompt excerpts, credentials, tool arguments, or image bytes enter diagnostics. */
export function describeQoderText(text: string) {
  return {
    chars: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
    tags: {
      think: (text.match(/<\/?think>/g) ?? []).length,
      thinking: (text.match(/<\/?thinking>/g) ?? []).length,
      analysis: (text.match(/<\/?analysis>/g) ?? []).length,
      summary: (text.match(/<\/?summary>/g) ?? []).length,
      dsml: (text.match(/\uFF5C+DSML\uFF5C+/g) ?? []).length,
    },
    summaryInstructions: SUMMARY_INSTRUCTIONS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
  };
}

export function describeQoderMessages(messages: ReturnType<typeof transformMessagesForQoder>) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    content: describeQoderText(
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
    ),
    ...(message.reasoning_content ? { reasoning: describeQoderText(message.reasoning_content) } : {}),
    images: Array.isArray(message.content)
      ? message.content
          .filter((part) => part.type === "image_url")
          .map((part) => ({
            urlChars: part.image_url.url.length,
            inline: part.image_url.url.startsWith("data:"),
          }))
      : [],
    toolCalls: message.tool_calls?.map((call) => ({
      name: call.function.name,
      arguments: describeQoderText(call.function.arguments),
    })),
    toolResult: message.role === "tool",
  }));
}
