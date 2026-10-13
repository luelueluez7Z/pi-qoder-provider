import type { transformMessagesForQoder } from "./transform.js";

type QoderMessages = ReturnType<typeof transformMessagesForQoder>;
type QoderRequestBody = Record<string, unknown> & { messages: QoderMessages };

const OMITTED_IMAGE = { type: "text" as const, text: "[Earlier image omitted to fit the request size limit.]" };

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
