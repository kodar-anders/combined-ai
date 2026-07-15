import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../errors";
import {
  assertValidTimeoutMs,
  mergeRetry,
  readJsonBody,
  requestControls,
  requestWithRetry,
} from "../transport";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (...args: any[]) => any): jest.Mock {
  const fn = jest.fn(impl);
  (globalThis as any).fetch = fn;
  return fn;
}

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
};

/** A minimal `Response`-like object good enough for `requestWithRetry`. */
function response(
  status: number,
  headers: Record<string, string> = {},
): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(`status ${String(status)}`),
  };
}

const URL = "https://example.test/v1";
const INIT: RequestInit = { method: "POST" };

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("requestWithRetry", () => {
  it("returns the first successful response without retrying", async () => {
    const fetchMock = mockFetch(() => response(200));

    const res = await requestWithRetry("anthropic", URL, INIT);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a non-retryable error response immediately (caller throws)", async () => {
    const fetchMock = mockFetch(() => response(401));

    const res = await requestWithRetry("openai", URL, INIT);

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and returns the eventual success", async () => {
    jest.useFakeTimers();
    let call = 0;
    const fetchMock = mockFetch(() => {
      call += 1;
      return response(call < 3 ? 429 : 200);
    });

    const promise = requestWithRetry("anthropic", URL, INIT, {
      baseDelayMs: 100,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([429, 503, 529])("retries the routine status %i", async (status) => {
    jest.useFakeTimers();
    let call = 0;
    const fetchMock = mockFetch(() => {
      call += 1;
      return response(call < 2 ? status : 200);
    });

    const promise = requestWithRetry("gemini", URL, INIT, {
      baseDelayMs: 1,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and returns the last retryable response", async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetch(() => response(503));

    const promise = requestWithRetry("openai", URL, INIT, {
      maxRetries: 2,
      baseDelayMs: 1,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    const res = await promise;

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry when maxRetries is 0", async () => {
    const fetchMock = mockFetch(() => response(429));

    const res = await requestWithRetry("anthropic", URL, INIT, {
      maxRetries: 0,
    });

    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially from the base delay", async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetch(() => response(429));

    void requestWithRetry("anthropic", URL, INIT, {
      maxRetries: 3,
      baseDelayMs: 500,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First retry waits 500ms.
    await jest.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second retry waits 1000ms.
    await jest.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors a Retry-After header in seconds over the backoff", async () => {
    jest.useFakeTimers();
    let call = 0;
    const fetchMock = mockFetch(() => {
      call += 1;
      return call < 2 ? response(429, { "retry-after": "2" }) : response(200);
    });

    void requestWithRetry("openai", URL, INIT, { baseDelayMs: 1 });

    await jest.advanceTimersByTimeAsync(0);
    // Backoff would be 1ms; Retry-After pins it to 2s.
    await jest.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a transport rejection without retrying", async () => {
    const fetchMock = mockFetch(() =>
      Promise.reject(new TypeError("network down")),
    );

    const error = await requestWithRetry("gemini", URL, INIT).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("mergeRetry", () => {
  it("returns the provider retry when the request has none", () => {
    expect(mergeRetry(undefined, { maxRetries: 3 })).toEqual({ maxRetries: 3 });
  });

  it("returns the request retry when the provider has none", () => {
    expect(mergeRetry({ maxRetries: 1 }, undefined)).toEqual({ maxRetries: 1 });
  });

  it("returns undefined when neither is set", () => {
    expect(mergeRetry(undefined, undefined)).toBeUndefined();
  });

  it("merges field-by-field with the request winning (explicit 0 disables)", () => {
    expect(
      mergeRetry({ maxRetries: 0 }, { maxRetries: 3, baseDelayMs: 100 }),
    ).toEqual({ maxRetries: 0, baseDelayMs: 100 });
  });
});

describe("assertValidTimeoutMs", () => {
  it("accepts undefined and positive values", () => {
    expect(() => assertValidTimeoutMs(undefined)).not.toThrow();
    expect(() => assertValidTimeoutMs(1000)).not.toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "throws on %p",
    (value) => {
      expect(() => assertValidTimeoutMs(value)).toThrow(/timeoutMs/);
    },
  );
});

describe("requestControls", () => {
  it("returns the caller's signal unchanged when no timeoutMs is set", () => {
    const { signal } = new AbortController();
    expect(requestControls({ signal }).signal).toBe(signal);
  });

  it("returns no signal when neither signal nor timeoutMs is set", () => {
    expect(requestControls({}).signal).toBeUndefined();
  });

  it("creates a timeout signal that aborts with a TimeoutError", async () => {
    const { signal } = requestControls({ timeoutMs: 5 });
    if (signal === undefined) {
      throw new Error("expected a timeout signal");
    }
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
  });

  it("combines the caller's signal with the timeout (a caller abort keeps its reason)", () => {
    const controller = new AbortController();
    const { signal } = requestControls({
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    if (signal === undefined) {
      throw new Error("expected a combined signal");
    }
    controller.abort(new Error("user cancelled"));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("user cancelled");
  });

  it("throws up front on an invalid timeoutMs", () => {
    expect(() => requestControls({ timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("merges the per-request retry over the provider's", () => {
    expect(
      requestControls({ retry: { maxRetries: 5 } }, { baseDelayMs: 1000 })
        .retry,
    ).toEqual({ baseDelayMs: 1000, maxRetries: 5 });
  });

  it("times out a hung fetch as a transport ProviderError", async () => {
    mockFetch(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const { signal } = init;
          if (!signal) {
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    );

    const { signal, retry } = requestControls({ timeoutMs: 10 });
    const error = await requestWithRetry(
      "openai",
      URL,
      {
        ...INIT,
        signal,
      },
      retry,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect(((error as ProviderError).cause as Error).name).toBe("TimeoutError");
  });
});

describe("readJsonBody", () => {
  it("returns the parsed body", async () => {
    const res = {
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response;
    await expect(readJsonBody("openai", res)).resolves.toEqual({ ok: true });
  });

  it("wraps an abort during the read as a transport ProviderError", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const res = {
      json: () => Promise.reject(abort),
    } as unknown as Response;

    const error = await readJsonBody("openai", res).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect((error as ProviderError).cause).toBe(abort);
  });

  it("leaves a malformed-body SyntaxError raw", async () => {
    const syntax = new SyntaxError("Unexpected token");
    const res = {
      json: () => Promise.reject(syntax),
    } as unknown as Response;

    const error = await readJsonBody("openai", res).catch((e: unknown) => e);

    expect(error).toBe(syntax);
  });
});
