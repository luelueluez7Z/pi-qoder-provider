import type {
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Fallback thinking-tag parser.
//
// Qoder's backend sometimes carries a literal `<thinking>` opener in the
// `reasoning_content` channel and the matching `</thinking>` closer in the
// normal `content` stream. On top of that, some upstreams inline entire
// thinking blocks inside the content stream delimited by tag variants. This
// parser buffers content across SSE deltas, extracts thinking/reasoning blocks,
// and emits them as structured thinking content blocks while keeping plain text
// clean.
// ---------------------------------------------------------------------------

export const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: " thinking", close: " response" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];

/** Length of the longest suffix of `text` that could be the start of `tag`. */
function trailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function maxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags) {
    maxLength = Math.max(maxLength, trailingPossibleTagPrefixLength(text, tag));
  }
  return maxLength;
}

/** Remove every thinking/reasoning tag variant (open and close) from `text`.
 *  Best-effort per chunk; a tag split across deltas is handled by the parser. */
export function stripThinkingTags(text: string): string {
  let out = text;
  for (const { open, close } of THINKING_TAG_VARIANTS) {
    if (open.length > 0 && out.includes(open)) out = out.split(open).join("");
    if (close.length > 0 && out.includes(close)) out = out.split(close).join("");
  }
  return out;
}

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private lastTextBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_TAG_VARIANTS[0].close;

  constructor(
    private output: AssistantMessage,
    private stream: AssistantMessageEventStream,
  ) {}

  processChunk(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;

      if (!this.inThinking && !this.thinkingExtracted) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.thinkingExtracted) {
        this.processAfterThinking();
        break;
      }
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (this.textBuffer.length === 0) return;
    if (this.inThinking && this.thinkingBlockIndex !== null) {
      const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
      block.thinking += this.textBuffer;
      this.stream.push({
        type: "thinking_delta",
        contentIndex: this.thinkingBlockIndex,
        delta: this.textBuffer,
        partial: this.output,
      });
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.thinkingBlockIndex,
        content: block.thinking,
        partial: this.output,
      });
    } else {
      this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex;
  }

  private processBeforeThinking(): void {
    // Locate the earliest opener and earliest closer in the buffer.
    let bestOpenPos = -1;
    let bestOpenVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    let bestClosePos = -1;
    let bestCloseVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;

    for (const variant of THINKING_TAG_VARIANTS) {
      const openPos = this.textBuffer.indexOf(variant.open);
      if (openPos !== -1 && (bestOpenPos === -1 || openPos < bestOpenPos)) {
        bestOpenPos = openPos;
        bestOpenVariant = variant;
      }
      const closePos = this.textBuffer.indexOf(variant.close);
      if (closePos !== -1 && (bestClosePos === -1 || closePos < bestClosePos)) {
        bestClosePos = closePos;
        bestCloseVariant = variant;
      }
    }

    // Opener first (or only tag): a real thinking block in the content stream.
    if (bestOpenVariant !== null && (bestCloseVariant === null || bestOpenPos < bestClosePos)) {
      if (bestOpenPos > 0) this.emitText(this.textBuffer.slice(0, bestOpenPos));
      this.textBuffer = this.textBuffer.slice(bestOpenPos + bestOpenVariant.open.length);
      this.activeEndTag = bestOpenVariant.close;
      this.inThinking = true;
      return;
    }

    // Orphan closer with no preceding opener: its matching opener arrived via
    // the `reasoning_content` channel, so there is no thinking block to close
    // here. Drop it (and the separator whitespace after it).
    if (bestCloseVariant !== null) {
      if (bestClosePos > 0) this.emitText(this.textBuffer.slice(0, bestClosePos));
      this.textBuffer = this.textBuffer.slice(bestClosePos + bestCloseVariant.close.length);
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      else if (this.textBuffer.startsWith("\n")) this.textBuffer = this.textBuffer.slice(1);
      return;
    }

    // No complete tag yet: hold back any trailing prefix that could be the
    // start of an opener or closer so a tag split across deltas is not emitted
    // partially as text.
    const allTags = THINKING_TAG_VARIANTS.flatMap((variant) => [variant.open, variant.close]);
    const trailingPrefixLength = maxTrailingPossibleTagPrefixLength(this.textBuffer, allTags);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      this.lastTextBlockIndex = this.textBlockIndex;
      this.textBlockIndex = null;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }

    const trailingPrefixLength = trailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processAfterThinking(): void {
    this.emitText(this.textBuffer);
    this.textBuffer = "";
  }

  private emitText(text: string): void {
    if (!text) return;
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.textBlockIndex] as TextContent;
    block.text += text;
    this.stream.push({ type: "text_delta", contentIndex: this.textBlockIndex, delta: text, partial: this.output });
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    if (this.thinkingBlockIndex === null) {
      if (this.textBlockIndex !== null) {
        // Insert the thinking block before the current text block.
        this.thinkingBlockIndex = this.textBlockIndex;
        this.output.content.splice(this.thinkingBlockIndex, 0, { type: "thinking", thinking: "" });
        this.textBlockIndex = this.textBlockIndex + 1;
      } else {
        this.thinkingBlockIndex = this.output.content.length;
        this.output.content.push({ type: "thinking", thinking: "" });
      }
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    block.thinking += thinking;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: thinking,
      partial: this.output,
    });
  }
}
