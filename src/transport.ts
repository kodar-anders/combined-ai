/**
 * HTTP transport for the providers: a `fetch` wrapper that turns network
 * failures into typed errors, plus bounded retry/backoff on routine retryable
 * statuses. The error *vocabulary* (`ProviderError`, `apiError`) lives in
 * `./errors`; this module is about how a request is made.
 */

import { transportError } from "./errors";
import { type ProviderName } from "./registry";
import { type RetryOptions } from "./types";

// `RetryOptions` lives in `./types` (a pure leaf) so this module can depend on it
// without inverting the dependency graph; re-export it here for back-compat, since
// the public `index.ts` and the provider option types import it from `./transport`.
export { type RetryOptions } from "./types";

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
    throw transportError(provider, cause);
  }
}

/** Routine, retryable failures: rate limit, transient unavailable, Anthropic overloaded. */
const RETRYABLE_STATUSES = new Set([429, 503, 529]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
/** Ceiling so a server-sent `Retry-After` or a high attempt count can't park us forever. */
const MAX_BACKOFF_MS = 60_000;
/**
 * `setTimeout`'s max delay (~24.8 days). A larger value overflows and Node clamps
 * the delay to 1ms — firing almost immediately, the opposite of a long timeout — so
 * reject it up front instead.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Merge a per-request {@link RetryOptions} over the provider's construction-time one,
 * field by field (spread, not `??`, so an explicit `maxRetries: 0` wins). Either side
 * being `undefined` falls through to the other.
 */
export function mergeRetry(
  requestRetry: RetryOptions | undefined,
  providerRetry: RetryOptions | undefined,
): RetryOptions | undefined {
  if (requestRetry === undefined) {
    return providerRetry;
  }
  if (providerRetry === undefined) {
    return requestRetry;
  }
  return { ...providerRetry, ...requestRetry };
}

/**
 * Validate a per-request `timeoutMs` (throwing a clear {@link Error} rather than
 * letting a bad value produce a `RangeError` deep in `AbortSignal.timeout`, or the
 * silent overflow-to-1ms footgun). A no-op when `timeoutMs` is `undefined`.
 */
export function assertValidTimeoutMs(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) {
    return;
  }
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be a positive number of milliseconds ≤ ${String(MAX_TIMEOUT_MS)}; got ${String(timeoutMs)}.`,
    );
  }
}

/**
 * Combine the caller's abort `signal` with a `timeoutMs` deadline. Returns `signal`
 * unchanged when no timeout is set; otherwise an {@link AbortSignal} that aborts when
 * either the caller aborts or the timeout elapses. The timeout signal aborts with a
 * `TimeoutError`, so a timeout is distinguishable from a caller abort downstream.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return signal;
  }
  assertValidTimeoutMs(timeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Resolve the per-request transport controls a provider passes to
 * {@link requestWithRetry}: the effective abort signal ({@link withTimeout}) and the
 * effective retry ({@link mergeRetry}). Called once per `complete()`/`stream()`/`embed()`
 * — and, for the timeout timer's sake, **after** any synchronous request validation so a
 * pre-fetch throw doesn't orphan it. The structural param accepts both a
 * {@link CompletionRequest} and an {@link EmbeddingRequest}.
 */
export function requestControls(
  request: {
    signal?: AbortSignal;
    timeoutMs?: number;
    retry?: RetryOptions;
  },
  providerRetry?: RetryOptions,
): { signal?: AbortSignal; retry?: RetryOptions } {
  return {
    signal: withTimeout(request.signal, request.timeoutMs),
    retry: mergeRetry(request.retry, providerRetry),
  };
}

/**
 * Read and JSON-parse a response body, converting an abort/timeout or network
 * failure that fires **during the body read** into a transport {@link ProviderError}
 * — `requestWithRetry` only wraps up to the response headers, so without this a
 * `timeoutMs` (or `signal`) firing while the body streams in would escape as a raw
 * `DOMException`/`TypeError`. A genuine parse failure (malformed 2xx body) is a
 * protocol error, not a transport one, so a `SyntaxError` propagates unchanged.
 */
export async function readJsonBody(
  provider: ProviderName,
  response: Response,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw cause;
    }
    throw transportError(provider, cause);
  }
}

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
