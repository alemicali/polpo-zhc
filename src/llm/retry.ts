/**
 * Exponential backoff retry utility for LLM/network calls.
 */

export interface RetryOptions {
  /** Max number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms (default: 1000) */
  initialDelayMs?: number;
  /** Max delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Whether to check if errors are transient (default: true) */
  checkTransient?: boolean;
}

/**
 * Check if an error is likely transient (worth retrying).
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("overloaded") ||
    msg.includes("rate limit")
  );
}

/**
 * Retry a function with exponential backoff and jitter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const initialDelay = opts.initialDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 30000;
  const checkTransient = opts.checkTransient ?? true;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;
      if (checkTransient && !isTransientError(err)) break;

      // Exponential backoff with jitter
      const baseDelay = Math.min(initialDelay * 2 ** attempt, maxDelay);
      const jitter = baseDelay * 0.5 * Math.random();
      await new Promise(r => setTimeout(r, baseDelay + jitter));
    }
  }

  throw lastError;
}
