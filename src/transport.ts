/**
 * HTTP transport for the providers: a `fetch` wrapper that turns network
 * failures into typed errors, plus bounded retry/backoff on routine retryable
 * statuses. The error *vocabulary* (`ProviderError`, `apiError`) lives in
 * `./errors`; this module is about how a request is made.
 */

import { ProviderError } from "./errors";
import { type ProviderName } from "./registry";

/**
 * `fetch` over the global, translating a rejected request (network/DNS failure,
 * aborted signal) into a `transport` {@link ProviderError} so the caller always
 * gets provider context instead of a bare `TypeError`.
 */
async function providerFetch(
  provider: ProviderName,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ProviderError(`${provider} request failed: ${reason}`, {
      provider,
      kind: "transport",
      cause,
    });
  }
}

/** Tuning for {@link requestWithRetry}'s bounded exponential backoff. */
export type RetryOptions = {
  /**
   * How many times to retry after the initial attempt on a retryable status
   * (429/503/529). `0` disables retry. Defaults to {@link DEFAULT_MAX_RETRIES}.
   */
  maxRetries?: number;
  /**
   * Base backoff in ms; the nth retry waits `baseDelayMs * 2 ** n` (capped at
   * {@link MAX_BACKOFF_MS}), unless the response carries a `Retry-After` header.
   * Defaults to {@link DEFAULT_BASE_DELAY_MS}.
   */
  baseDelayMs?: number;
};

/** Routine, retryable failures: rate limit, transient unavailable, Anthropic overloaded. */
const RETRYABLE_STATUSES = new Set([429, 503, 529]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
/** Ceiling so a server-sent `Retry-After` or a high attempt count can't park us forever. */
const MAX_BACKOFF_MS = 60_000;

/**
 * {@link providerFetch} with bounded exponential backoff on the retryable
 * statuses ({@link RETRYABLE_STATUSES}). Returns the first non-retryable
 * response (success or otherwise) for the caller to handle via `apiError`;
 * transport rejections propagate immediately (not retried). Honors the
 * response's `Retry-After` header when present; the wait is abortable via
 * `init.signal` (an abort during backoff lets the next attempt's `fetch` reject
 * into a transport {@link ProviderError}).
 */
export async function requestWithRetry(
  provider: ProviderName,
  input: string,
  init: RequestInit,
  retry?: RetryOptions,
): Promise<Response> {
  const maxRetries = Math.max(0, retry?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    const response = await providerFetch(provider, input, init);
    if (
      response.ok ||
      !RETRYABLE_STATUSES.has(response.status) ||
      attempt >= maxRetries
    ) {
      return response;
    }
    const delayMs = retryDelayMs(response, attempt, baseDelayMs);
    // Free the connection — we won't read this error body before retrying.
    await response.body?.cancel();
    await sleep(delayMs, init.signal ?? undefined);
  }
}

function retryDelayMs(
  response: Response,
  attempt: number,
  baseDelayMs: number,
): number {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_BACKOFF_MS);
  }
  return Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
}

/** `Retry-After` is either an integer count of seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

/**
 * Resolve after `ms`, or early if `signal` aborts (the caller's next `fetch`
 * then rejects with the abort, producing a transport {@link ProviderError}).
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
