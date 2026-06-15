import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../errors";
import { requestWithRetry } from "../transport";

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
