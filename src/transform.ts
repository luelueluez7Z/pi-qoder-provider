import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

// OpenAI-shaped schema for the Qoder gateway.

interface QoderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface QoderToolCall {
  id?: string;
  type: "function";
  function: { name?: string; arguments: string };
}

type QoderTextPart = { type: "text"; text: string };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart>;

interface QoderMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: QoderContent | null;
  tool_calls?: QoderToolCall[];
  tool_call_id?: string;
}

export function getContentText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

/** The image blocks of a message, in order. Empty when there are none. */
export function getContentImages(msg: Message): ImageContent[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function transformTools(tools: Tool[]): QoderTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function transformMessagesForQoder(messages: Message[]): QoderMessage[] {
  const normalizedMessages: QoderMessage[] = [];
  // tool_call_id → index (in normalizedMessages) of the assistant message that
  // issued it. An entry is removed as soon as the matching tool message arrives.
  const pendingToolCallIds = new Map<string, number>();

  for (const msg of messages) {
    // Skip failed assistant messages.
    if (
      msg.role === "assistant" &&
      ((msg as AssistantMessage).stopReason === "error" || (msg as AssistantMessage).stopReason === "aborted")
    ) {
      continue;
    }

    if (msg.role === "user") {
      let content: QoderContent = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((c) => c.type === "image");
        if (hasImage) {
          content = msg.content
            .map((c): QoderTextPart | QoderImagePart | null => {
              if (c.type === "text") return { type: "text", text: (c as TextContent).text };
              if (c.type === "image") {
                const img = c as ImageContent;
                return { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } };
              }
              return null;
            })
            .filter((p): p is QoderTextPart | QoderImagePart => p !== null);
        } else {
          content = getContentText(msg);
        }
      }
      normalizedMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const am = msg as AssistantMessage;
      let content = "";
      const toolCalls: QoderToolCall[] = [];

      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "text") {
            content += (block as TextContent).text;
          } else if (block.type === "thinking") {
            content += `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n`;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            toolCalls.push({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              },
            });
          }
        }
      } else {
        content = am.content || "";
      }

      // Qoder's gateway drops assistant messages whose content is null, which
      // orphans the following tool_result. When an assistant turn has tool calls
      // but no text/thinking, inject a single-space placeholder.
      const mapped: QoderMessage = {
        role: "assistant",
        content: content || (toolCalls.length > 0 ? " " : null),
      };
      if (toolCalls.length > 0) {
        mapped.tool_calls = toolCalls;
        for (const tc of toolCalls) {
          if (tc.id) pendingToolCallIds.set(tc.id, normalizedMessages.length);
        }
      }
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      // A tool result whose tool_call_id has no pending assistant message is
      // orphaned (its assistant message was skipped as aborted/errored). The
      // upstream rejects such messages, so drop them.
      if (!tr.toolCallId || !pendingToolCallIds.has(tr.toolCallId)) continue;
      pendingToolCallIds.delete(tr.toolCallId);
      normalizedMessages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: getContentText(tr),
      });

      // Tool results may carry images, which the OpenAI-shaped `tool` role
      // cannot express (its content is a plain string). Emit them as a separate
      // user message so the model can actually see them.
      const images = getContentImages(tr);
      if (images.length > 0) {
        normalizedMessages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by the previous tool call]`,
            },
            ...images.map(
              (img): QoderImagePart => ({
                type: "image_url",
                image_url: { url: `data:${img.mimeType};base64,${img.data}` },
              }),
            ),
          ],
        });
      }
    }
  }

  // Sanitize interrupted turns: an assistant message whose tool_calls were never
  // answered (e.g. an aborted/errored turn still present in the history) would
  // make the upstream reject the whole request with "an assistant message with
  // tool_calls must be followed by tool messages". Drop the unanswered tool
  // calls; drop the whole message when it carries no other content.
  for (let i = 0; i < normalizedMessages.length; i++) {
    const m = normalizedMessages[i];
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0) continue;
    const answered = m.tool_calls.filter((tc) => tc.id && !pendingToolCallIds.has(tc.id));
    if (answered.length === m.tool_calls.length) continue;
    if (answered.length > 0) {
      if (process.env.QODER_DEBUG) {
        console.warn(
          `[pi-provider-qoder] dropped ${m.tool_calls.length - answered.length} unanswered tool call(s) from assistant message`,
        );
      }
      m.tool_calls = answered;
      continue;
    }
    const content = typeof m.content === "string" ? m.content : "";
    if (content.trim() === "") {
      if (process.env.QODER_DEBUG) {
        console.warn("[pi-provider-qoder] dropped assistant message with unanswered tool calls (interrupted turn)");
      }
      normalizedMessages.splice(i, 1);
      i--;
    } else {
      delete m.tool_calls;
    }
  }

  return normalizedMessages;
}
