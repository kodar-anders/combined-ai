import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../../errors";
import { AnthropicProvider } from "../anthropic";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (...args: any[]) => any): jest.Mock {
  const fn = jest.fn(impl);
  (globalThis as any).fetch = fn;
  return fn;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("AnthropicProvider.complete", () => {
  it("sends the correct request and returns concatenated text", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "claude-opus-4-8",
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world." },
          ],
        }),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      system: "Be brief.",
    });

    expect(result).toEqual({ text: "Hello, world.", model: "claude-opus-4-8" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      messages: [{ role: "user", content: "Hi" }],
      system: "Be brief.",
    });
    expect(body.stream).toBeUndefined();
  });

  it("honors an explicit model and maxTokens", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "claude-haiku-4-5", content: [] }),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      model: "claude-haiku-4-5",
      maxTokens: 100,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.max_tokens).toBe(100);
  });

  it("forwards an abort signal to fetch", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "claude-opus-4-8", content: [] }),
    }));

    const controller = new AbortController();
    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("maps stop_reason and refusal blocks onto finishReason/refusal", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "claude-opus-4-8",
          stop_reason: "max_tokens",
          content: [{ type: "text", text: "Partial" }],
        }),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.finishReason).toBe("length");
    expect(result.rawFinishReason).toBe("max_tokens");
    expect(result.refusal).toBeUndefined();
  });

  it("flags a refusal stop and captures the refusal block text", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "claude-opus-4-8",
          stop_reason: "refusal",
          content: [{ type: "refusal", text: "I can't help with that." }],
        }),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("content_filter");
    expect(result.rawFinishReason).toBe("refusal");
    expect(result.refusal).toBe("I can't help with that.");
  });

  it("retries a 429 and returns the eventual success", async () => {
    jest.useFakeTimers();
    let call = 0;
    const fetchMock = mockFetch(() => {
      call += 1;
      if (call < 2) {
        return {
          ok: false,
          status: 429,
          headers: new Headers(),
          text: () => Promise.resolve("rate limited"),
        };
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "Recovered." }],
          }),
      };
    });

    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      retry: { baseDelayMs: 10 },
    });
    const promise = provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("Recovered.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("throws a typed ProviderError on a non-2xx response", async () => {
    mockFetch(() => ({
      ok: false,
      status: 401,
      text: () =>
        Promise.resolve(
          '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("anthropic");
    expect(providerError.status).toBe(401);
    expect(providerError.type).toBe("authentication_error");
    expect(providerError.message).toContain("anthropic request failed (401)");
  });

  it("throws a typed ProviderError on a 200 response with an error body", async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          type: "error",
          error: { type: "overloaded_error", message: "overloaded" },
        }),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("anthropic");
    expect(providerError.status).toBe(200);
    expect(providerError.type).toBe("overloaded_error");
    expect(providerError.message).toContain("anthropic request failed (200)");
  });

  it("wraps a fetch rejection in a transport ProviderError", async () => {
    mockFetch(() => Promise.reject(new TypeError("network down")));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("transport");
    expect(providerError.provider).toBe("anthropic");
    expect(providerError.status).toBeUndefined();
    expect(providerError.cause).toBeInstanceOf(TypeError);
  });
});

describe("AnthropicProvider.stream", () => {
  it("yields text deltas parsed from the SSE body", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
        'lo"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "Hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(["Hello", " world"]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(64000);
  });

  it("forwards an abort signal to fetch", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const controller = new AbortController();
    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "Hi" }],
      signal: controller.signal,
    })) {
      deltas.push(delta);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("skips blank and non-JSON data lines mid-stream", async () => {
    mockFetch(() => ({
      ok: true,
      body: sseStream([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        "data:\n\n",
        "data: not json\n\n",
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "Hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("releases the reader when the consumer breaks early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
          ),
        );
        // Deliberately leave the stream open so only an early break ends it.
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetch(() => ({ ok: true, body }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "Hi" }],
    })) {
      expect(delta).toBe("Hello");
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("throws on a streamed error event", async () => {
    mockFetch(() => ({
      ok: true,
      body: sseStream([
        'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n',
      ]),
    }));

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("Anthropic stream error");
  });

  it("throws on a non-2xx response before streaming", async () => {
    mockFetch(() => ({
      ok: false,
      status: 529,
      text: () => Promise.resolve("overloaded"),
    }));

    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      retry: { maxRetries: 0 },
    });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("anthropic request failed (529)");
  });
});
