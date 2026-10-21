import type { transformMessagesForQoder } from "./transform.js";

type QoderMessages = ReturnType<typeof transformMessagesForQoder>;
type QoderRequestBody = Record<string, unknown> & { messages: QoderMessages };

const OMITTED_IMAGE = { type: "text" as const, text: "[Earlier image omitted to fit the request size limit.]" };

// Text budget: Qoder counts characters as tokens (4 chars ≈ 1 token) and the
// model's context window is configured in ~/.qoder/settings.json. Keep history
// under 70% of it so the reply and tool schemas still fit, and estimate images
// at a fixed token cost instead of their base64 length.
const CHARS_PER_TOKEN = 4;
const BUDGET_RATIO = 0.7;
const IMAGE_TOKEN_COST = 1000;

type QoderMessage = QoderMessages[number];

export interface QoderTextBudgetResult {
  messages: QoderMessages;
  droppedMessages: number;
  truncatedMessages: number;
  estimatedChars: number;
  budgetChars: number;
}

function messageChars(message: QoderMessage): number {
  let chars = 64; // JSON envelope, role, keys
  const content = message.content;
  if (typeof content === "string") chars += content.length;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") chars += part.text.length;
      else chars += IMAGE_TOKEN_COST * CHARS_PER_TOKEN;
    }
  }
  if (message.reasoning_content) chars += message.reasoning_content.length;
  if (message.tool_calls) {
    for (const call of message.tool_calls) chars += (call.function.name?.length ?? 0) + call.function.arguments.length;
  }
  return chars;
}

/**
 * Group each assistant tool-call message with the tool results answering it, so
 * trimming never leaves an orphaned tool message (the gateway rejects those).
 */
function buildTrimGroups(messages: QoderMessages): number[][] {
  const groups: number[][] = [];
  const owners = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const group = [i];
      groups.push(group);
      for (const call of message.tool_calls) {
        if (call.id) owners.set(call.id, group);
      }
      continue;
    }
    if (message.role === "tool" && message.tool_call_id) {
      const owner = owners.get(message.tool_call_id);
      if (owner) {
        owner.push(i);
        continue;
      }
    }
    groups.push([i]);
  }
  return groups;
}

function truncateMessage(message: QoderMessage, maxChars: number): QoderMessage {
  if (maxChars < 0) maxChars = 0;
  const content = message.content;
  if (typeof content === "string") {
    if (content.length <= maxChars) return message;
    return { ...message, content: content.slice(0, maxChars) };
  }
  if (!Array.isArray(content)) return message;
  let remaining = maxChars;
  let changed = false;
  const parts = content.map((part) => {
    if (part.type !== "text" || part.text.length <= remaining) {
      if (part.type === "text") remaining = Math.max(0, remaining - part.text.length);
      return part;
    }
    changed = true;
    const text = part.text.slice(0, remaining);
    remaining = 0;
    return { ...part, text };
  });
  return changed ? { ...message, content: parts } : message;
}

/**
 * Fit the outgoing history inside the model's text budget without touching
 * stored history. Drops whole message groups oldest-first (never the last user
 * message), then clips oversized text as a last resort. Returns the original
 * array when the request already fits.
 */
export function trimQoderMessagesToBudget(
  messages: QoderMessages,
  contextWindow: number,
  overheadChars = 0,
): QoderTextBudgetResult {
  const budgetChars = Math.max(CHARS_PER_TOKEN, Math.floor(contextWindow * BUDGET_RATIO) * CHARS_PER_TOKEN - overheadChars);
  const sizes = messages.map(messageChars);
  let total = sizes.reduce((sum, value) => sum + value, 0);
  const result: QoderTextBudgetResult = {
    messages,
    droppedMessages: 0,
    truncatedMessages: 0,
    estimatedChars: total,
    budgetChars,
  };
  if (total <= budgetChars || messages.length === 0) return result;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const dropped = new Set<number>();
  let remaining = messages.length;
  for (const group of buildTrimGroups(messages)) {
    if (total <= budgetChars) break;
    if (group.includes(lastUserIdx)) continue;
    if (remaining - group.length < 1) continue;
    for (const index of group) {
      dropped.add(index);
      total -= sizes[index];
    }
    remaining -= group.length;
    result.droppedMessages += group.length;
  }

  if (total > budgetChars) {
    // Safety valve: clip text inside the messages that remain. Last user
    // message first (it is never dropped), then the largest others.
    const kept = messages.map((_, index) => index).filter((index) => !dropped.has(index));
    const candidates = [
      ...(lastUserIdx >= 0 && !dropped.has(lastUserIdx) ? [lastUserIdx] : []),
      ...kept.filter((index) => index !== lastUserIdx).sort((a, b) => sizes[b] - sizes[a]),
    ];
    const trimmed = messages.slice();
    for (const index of candidates) {
      if (total <= budgetChars) break;
      const current = sizes[index];
      const availableChars = Math.max(0, (current - (total - budgetChars) - 1));
      const next = truncateMessage(trimmed[index], availableChars);
      const nextChars = messageChars(next);
      if (nextChars < current) {
        trimmed[index] = next;
        total -= current - nextChars;
        result.truncatedMessages += 1;
      }
    }
    result.messages = dropped.size > 0 ? trimmed.filter((_, index) => !dropped.has(index)) : trimmed;
  } else if (dropped.size > 0) {
    result.messages = messages.filter((_, index) => !dropped.has(index));
  }

  result.estimatedChars = total;
  return result;
}

/**
 * Only the outgoing payload changes; stored history, text and tool pairs remain
 * intact. Keep the newest image even when that means failing with /compact advice.
 * Measure image replacements once rather than serializing the whole body per image.
 */
export function fitQoderImagesToBudget(
  body: QoderRequestBody,
  maxBytes: number,
): { bodyBytes: Buffer; messages: QoderMessages; omittedImages: number } {
  let serialized = JSON.stringify(body);
  let byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maxBytes) {
    return { bodyBytes: Buffer.from(serialized), messages: body.messages, omittedImages: 0 };
  }
  serialized = "";

  const candidates: { messageIndex: number; partIndex: number }[] = [];
  body.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (part.type === "image_url") candidates.push({ messageIndex, partIndex });
    });
  });

  const messages = body.messages.slice();
  const copiedMessages = new Set<number>();
  const replacementBytes = Buffer.byteLength(JSON.stringify(OMITTED_IMAGE));
  let omittedImages = 0;
  for (const { messageIndex, partIndex } of candidates.slice(0, -1)) {
    if (byteLength <= maxBytes) break;
    const originalContent = body.messages[messageIndex].content;
    if (!Array.isArray(originalContent)) continue;
    const savedBytes = Buffer.byteLength(JSON.stringify(originalContent[partIndex])) - replacementBytes;
    if (savedBytes <= 0) continue;
    if (!copiedMessages.has(messageIndex)) {
      messages[messageIndex] = { ...messages[messageIndex], content: originalContent.slice() };
      copiedMessages.add(messageIndex);
    }
    const content = messages[messageIndex].content;
    if (Array.isArray(content)) content[partIndex] = { ...OMITTED_IMAGE };
    byteLength -= savedBytes;
    omittedImages += 1;
  }

  if (byteLength > maxBytes) {
    throw new Error(
      `Qoder request body exceeded ${maxBytes} bytes (remaining ${byteLength} bytes). 已保留文本和最新图片；请 /compact 或新建会话，若最新图片本身过大请缩小后重试。`,
    );
  }
  const bodyBytes = Buffer.from(JSON.stringify({ ...body, messages }));
  if (bodyBytes.byteLength > maxBytes) {
    throw new Error(`Qoder request body exceeded ${maxBytes} bytes. 请 /compact 后重试。`);
  }
  return { bodyBytes, messages, omittedImages };
}
