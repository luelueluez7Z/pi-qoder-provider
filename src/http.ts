const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

function configuredTimeoutMs(): number {
  const raw = process.env.QODER_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_HTTP_TIMEOUT_MS;
  return value;
}

/** Run a Qoder HTTP operation with one abortable timeout and parent cancellation. */
export async function withQoderHttpTimeout<T>(
  label: string,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((reason: Error) => void) | undefined;
  let rejectParent: ((reason: unknown) => void) | undefined;

  const onParentAbort = () => {
    const reason = parentSignal?.reason ?? new Error("aborted");
    controller.abort(reason);
    rejectParent?.(reason);
  };
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeoutMs = configuredTimeoutMs();
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(new Error("Qoder HTTP timeout"));
    }, timeoutMs);
  }

  try {
    const operationPromise = operation(controller.signal);
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const parentPromise = new Promise<never>((_, reject) => {
      rejectParent = reject;
      if (parentSignal?.aborted) reject(parentSignal.reason ?? new Error("aborted"));
    });
    const races: Promise<T | never>[] = [operationPromise];
    if (timeoutMs > 0) races.push(timeoutPromise);
    if (parentSignal) races.push(parentPromise);
    return await Promise.race(races);
  } catch (error) {
    if (timedOut) {
      throw new Error(`Qoder ${label} timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
