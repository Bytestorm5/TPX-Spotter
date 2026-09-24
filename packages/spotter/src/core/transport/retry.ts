/**
 * Retry with exponential backoff and jitter, honouring `Retry-After`.
 *
 * Retried: network failures (fetch rejects), timeouts, 408, 429 and 5xx.
 * Not retried: other 4xx — the request itself is wrong, and repeating it
 * only burns the reporter's battery and the project's quota.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = "SpotterHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 4. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each retry (e.g. to resync an upload offset). */
  onRetry?: (attempt: number, error: unknown) => void | Promise<void>;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  // fetch network failures are TypeErrors; timeouts are AbortError / TimeoutError DOMExceptions
  if (error instanceof TypeError) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError" || name === "NetworkError";
}

/** Equal jitter: half the exponential delay fixed, half random, so retries from many clients spread out. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/** `Retry-After`: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 15_000;
  const wait = options.sleep ?? sleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      const hinted = error instanceof HttpError ? error.retryAfterMs : undefined;
      // Retry-After is a floor from the server; cap it so a report never hangs for minutes in the foreground.
      const delay = hinted !== undefined ? Math.min(Math.max(hinted, base), max * 4) : backoffDelay(attempt, base, max, options.random);
      await wait(delay);
      await options.onRetry?.(attempt + 1, error);
    }
  }
  throw lastError;
}
