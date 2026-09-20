export interface DsmlToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const INVOKE_END = "</invoke>";
// Qoder occasionally tokenizes DSML tags with a `｜DSML｜` (U+FF5C) wrapper,
// e.g. `<｜DSML｜ invoke name="bash">` / `</｜DSML｜ invoke>`; normalizeDsmlVariants
// rewrites them into plain XML tags.

const PARAMETER_PATTERN = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
const TRAILING_CLOSES_PATTERN = /^(?:\s*<\/(?:parameter|invoke|calls)\s*>)+\s*/i;

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

/** Rewrite `｜DSML｜`-wrapped tags into plain XML tags so the standard parsers can read them. */
function normalizeDsmlVariants(text: string): string {
  if (!text.includes("\uFF5C")) return text;
  return text
    .replace(/<\/\uFF5CDSML\uFF5C\s*(\w+)\s*>/g, "</$1>")
    .replace(/<\uFF5CDSML\uFF5C\s*(\w+)([^>]*)>/g, "<$1$2>");
}

function extractParameters(body: string): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  let foundParameter = false;
  for (const match of body.matchAll(PARAMETER_PATTERN)) {
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
  return foundParameter ? args : undefined;
}

function parseInvocation(raw: string): DsmlToolCall | undefined {
  const open = raw.match(/^<invoke\b([^>]*)>/i);
  if (!open) return undefined;
  const name = attribute(open[1], "name");
  if (!name) return undefined;

  const body = raw.slice(open[0].length, -INVOKE_END.length);
  const args = extractParameters(body);
  // A named invocation with no parameters is valid for no-argument tools.
  return args || body.trim() === "" ? { name, arguments: args ?? {} } : undefined;
}

// ponytail: host tool names inferred from parameter shapes; extend when pi's tool set changes.
function inferToolName(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === "string" && args.command.trim() !== "") return "powershell";
  if ("question" in args || "remark" in args || "options" in args) return "ask_user";
  return undefined;
}

/**
 * Parse Qoder's degenerate DSML: the `<invoke name="...">` opener is missing
 * entirely and only `<parameter>...</parameter>` plus closing tags survive,
 * e.g. `<parameter name="command">...</parameter>\n</invoke>\n</parameter>...`.
 * The tool name is inferred from the parameter shape.
 */
function parseIncompleteInvocation(raw: string): DsmlToolCall | undefined {
  if (!/<\/invoke\s*>/i.test(raw)) return undefined;
  const args = extractParameters(raw);
  if (!args) return undefined;
  const name = inferToolName(args);
  return name ? { name, arguments: args } : undefined;
}

/**
 * Hold back a trailing unterminated `<...` run so a tag split across deltas
 * is never emitted as text. ponytail: flushes after 64 chars so prose that
 * merely contains a stray `<` cannot buffer forever.
 */
function partialTagStart(value: string): number | undefined {
  const lastOpen = value.lastIndexOf("<");
  if (lastOpen === -1) return undefined;
  const partial = value.slice(lastOpen);
  if (partial.includes(">") || partial.length > 64) return undefined;
  return lastOpen;
}

/** True when `text` ends with a `<...` that has not seen its `>` yet. */
function endsWithPartialTag(text: string): boolean {
  const lastOpen = text.lastIndexOf("<");
  return lastOpen !== -1 && !text.slice(lastOpen).includes(">");
}

export interface DsmlToolParserOptions {
  /**
   * Only recover degenerate (opener-less) invocations. Used for the reasoning
   * channel, where a *complete* `<invoke>` draft is just the model thinking
   * out loud and must stay thinking text.
   */
  incompleteOnly?: boolean;
}

/** Converts Qoder's occasional XML/DSML tool calls into pi tool-call events. */
export class DsmlToolParser {
  private textBuffer = "";
  private invocationBuffer: string | undefined;

  constructor(
    private readonly emitText: (text: string) => void,
    private readonly emitTool: (tool: DsmlToolCall) => void,
    private readonly options: DsmlToolParserOptions = {},
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.textBuffer += chunk;
    this.drain();
  }

  finish(): void {
    this.textBuffer = normalizeDsmlVariants(this.textBuffer);
    if (this.invocationBuffer !== undefined) {
      this.invocationBuffer += this.textBuffer;
      this.textBuffer = "";
      this.invocationBuffer = normalizeDsmlVariants(this.invocationBuffer);
      let tool: DsmlToolCall | undefined;
      if (this.invocationBuffer.includes(INVOKE_END)) {
        tool = parseInvocation(this.invocationBuffer) ?? parseIncompleteInvocation(this.invocationBuffer);
      }
      if (tool) this.emitTool(tool);
      else this.emitText(this.invocationBuffer);
      this.invocationBuffer = undefined;
    }
    this.emitText(this.textBuffer);
    this.textBuffer = "";
  }

  private drain(): void {
    this.textBuffer = normalizeDsmlVariants(this.textBuffer);
    while (true) {
      if (this.invocationBuffer !== undefined) {
        this.invocationBuffer += this.textBuffer;
        this.textBuffer = "";
        this.invocationBuffer = normalizeDsmlVariants(this.invocationBuffer);
        const end = this.invocationBuffer.indexOf(INVOKE_END);
        if (end < 0) return;
        // Wait while only whitespace/closing tags follow (or a split close
        // tag is still arriving), so closes that trickle in after the
        // invocation are never leaked as text.
        const after = this.invocationBuffer.slice(end + INVOKE_END.length);
        if (/^(?:\s*<\/(?:parameter|invoke|calls)\s*>)*\s*$/.test(after) || endsWithPartialTag(after)) return;
        const raw = this.invocationBuffer.slice(0, end + INVOKE_END.length);
        const tool = parseInvocation(raw) ?? parseIncompleteInvocation(raw);
        if (tool) {
          this.emitTool(tool);
          this.textBuffer = this.invocationBuffer.slice(end + INVOKE_END.length).replace(TRAILING_CLOSES_PATTERN, "");
        } else {
          this.emitText(raw);
          this.textBuffer = this.invocationBuffer.slice(end + INVOKE_END.length);
        }
        this.invocationBuffer = undefined;
        continue;
      }

      if (!this.options.incompleteOnly) {
        const invokeMatch = this.textBuffer.match(/<invoke(?:\s|>)/i);
        if (invokeMatch?.index !== undefined) {
          this.emitText(this.textBuffer.slice(0, invokeMatch.index));
          this.invocationBuffer = this.textBuffer.slice(invokeMatch.index);
          this.textBuffer = "";
          continue;
        }
      }

      // Degenerate invocation: parameters with no `<invoke>` opener. Only
      // trust it when the parameters sit at a line start — mid-sentence
      // `<parameter>` in prose must stay plain text.
      const paramMatch = this.textBuffer.match(/<parameter\b[^>]*>/i);
      if (paramMatch?.index !== undefined) {
        const prefix = this.textBuffer.slice(0, paramMatch.index);
        if (prefix === "" || /(?:^|\n)[^\S\n]*$/.test(prefix)) {
          this.emitText(prefix);
          this.invocationBuffer = this.textBuffer.slice(paramMatch.index);
          this.textBuffer = "";
          continue;
        }
      }

      const keepFrom = partialTagStart(this.textBuffer);
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
