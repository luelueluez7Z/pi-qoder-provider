export interface DsmlToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const INVOKE_MARKER = "<invoke";
const INVOKE_END = "</invoke>";

function attribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseInvocation(raw: string): DsmlToolCall | undefined {
  const open = raw.match(/^<invoke\b([^>]*)>/i);
  if (!open) return undefined;
  const name = attribute(open[1], "name");
  if (!name) return undefined;

  const body = raw.slice(open[0].length, -INVOKE_END.length);
  const args: Record<string, unknown> = {};
  const parameterPattern = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
  let foundParameter = false;
  for (const match of body.matchAll(parameterPattern)) {
    const parameterName = attribute(match[1], "name");
    if (!parameterName) continue;
    foundParameter = true;
    const value = decodeXml(match[2].trim());
    if (attribute(match[1], "string")?.toLowerCase() === "false") {
      try {
        args[parameterName] = JSON.parse(value);
      } catch {
        args[parameterName] = value;
      }
    } else {
      args[parameterName] = value;
    }
  }

  // A named invocation with no parameters is valid for no-argument tools.
  return foundParameter || body.trim() === "" ? { name, arguments: args } : undefined;
}

function partialInvokeStart(value: string): number | undefined {
  const start = Math.max(0, value.length - INVOKE_MARKER.length);
  for (let index = start; index < value.length; index += 1) {
    if (INVOKE_MARKER.startsWith(value.slice(index))) return index;
  }
  return undefined;
}

/** Converts Qoder's occasional XML/DSML tool calls into pi tool-call events. */
export class DsmlToolParser {
  private textBuffer = "";
  private invocationBuffer: string | undefined;

  constructor(
    private readonly emitText: (text: string) => void,
    private readonly emitTool: (tool: DsmlToolCall) => void,
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.textBuffer += chunk;
    this.drain();
  }

  finish(): void {
    if (this.invocationBuffer !== undefined) {
      this.emitText(this.invocationBuffer);
      this.invocationBuffer = undefined;
    }
    this.emitText(this.textBuffer);
    this.textBuffer = "";
  }

  private drain(): void {
    while (true) {
      if (this.invocationBuffer !== undefined) {
        const end = this.invocationBuffer.indexOf(INVOKE_END);
        if (end < 0) return;
        const endOffset = end + INVOKE_END.length;
        const raw = this.invocationBuffer.slice(0, endOffset);
        const tool = parseInvocation(raw);
        if (tool) this.emitTool(tool);
        else this.emitText(raw);
        this.textBuffer = this.invocationBuffer.slice(endOffset) + this.textBuffer;
        this.invocationBuffer = undefined;
        continue;
      }

      const match = this.textBuffer.match(/<invoke(?:\s|>)/i);
      if (match?.index !== undefined) {
        this.emitText(this.textBuffer.slice(0, match.index));
        this.invocationBuffer = this.textBuffer.slice(match.index);
        this.textBuffer = "";
        continue;
      }

      const keepFrom = partialInvokeStart(this.textBuffer);
      if (keepFrom === undefined) {
        this.emitText(this.textBuffer);
        this.textBuffer = "";
      } else if (keepFrom > 0) {
        this.emitText(this.textBuffer.slice(0, keepFrom));
        this.textBuffer = this.textBuffer.slice(keepFrom);
      }
      return;
    }
  }
}
