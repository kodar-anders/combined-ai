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

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
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
