import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// On-disk debug logging.
//
// QODER_DEBUG (and the legacy QODER_COSY_DEBUG flag) switch on silent debug
// logging to a file instead of spamming the terminal: every request/response,
// SSE lifecycle event and sanitization decision is appended to
// ~/.pi/agent/logs/qoder-provider-debug.log (override with QODER_DEBUG_FILE).
// Logging is best-effort and never throws into the request path.
// ---------------------------------------------------------------------------

const DEFAULT_LOG_FILE = join(homedir(), ".pi", "agent", "logs", "qoder-provider-debug.log");

function isDebugEnabled(): boolean {
    const value = (process.env.QODER_DEBUG || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

function isCosyDebugEnabled(): boolean {
    const value = (process.env.QODER_COSY_DEBUG || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isQoderDebugEnabled(): boolean {
    return isDebugEnabled() || isCosyDebugEnabled();
}

function resolveLogFile(): string {
    const custom = process.env.QODER_DEBUG_FILE;
    return custom && custom.trim() !== "" ? custom : DEFAULT_LOG_FILE;
}

/** Append one debug line to the on-disk log. Never throws. */
export function logDebug(level: string, message: unknown): void {
    if (!isQoderDebugEnabled()) return;
    try {
        const file = resolveLogFile();
        mkdirSync(dirname(file), { recursive: true });
        const rendered = typeof message === "string" ? message : JSON.stringify(message);
        const line = `[${new Date().toISOString()}] [${level}] ${rendered}\n`;
        appendFileSync(file, line, "utf8");
    } catch {
        // Logging must never break the request path.
    }
}
