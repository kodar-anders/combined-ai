import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../../errors";
import { OpenAIProvider } from "../openai";

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

describe("OpenAIProvider.complete", () => {
  it("sends the correct request and returns the message content", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [
            {
              message: { role: "assistant", content: "Hello, world." },
            },
          ],
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      system: "Be brief.",
    });

    expect(result).toEqual({ text: "Hello, world.", model: "gpt-4.1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gpt-4.1",
      max_completion_tokens: 16000,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(body.stream).toBeUndefined();
  });

  it("omits the system message when no system prompt is given", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ model: "gpt-4.1", choices: [{ message: {} }] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.complete({ messages: [{ role: "user", content: "Hi" }] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("honors an explicit model and maxTokens", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1-mini", choices: [] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4.1-mini",
      maxTokens: 100,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.max_completion_tokens).toBe(100);
  });

  it("forwards an abort signal to fetch", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));

    const controller = new AbortController();
    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("maps finish_reason length onto finishReason", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [
            { finish_reason: "length", message: { content: "Truncated" } },
          ],
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.finishReason).toBe("length");
    expect(result.rawFinishReason).toBe("length");
    expect(result.refusal).toBeUndefined();
  });

  it("surfaces a refusal as content_filter regardless of finish_reason", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [
            {
              finish_reason: "stop",
              message: { content: "", refusal: "I won't do that." },
            },
          ],
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("content_filter");
    expect(result.rawFinishReason).toBe("stop");
    expect(result.refusal).toBe("I won't do that.");
  });

  it("throws a typed ProviderError parsing the OpenAI error body", async () => {
    mockFetch(() => ({
      ok: false,
      status: 401,
      text: () =>
        Promise.resolve(
          '{"error":{"message":"bad key","type":"invalid_request_error","code":"invalid_api_key"}}',
        ),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("openai");
    expect(providerError.status).toBe(401);
    expect(providerError.code).toBe("invalid_api_key");
    expect(providerError.type).toBe("invalid_request_error");
  });

  it("throws a typed ProviderError on a 200 response with an error body", async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          error: { code: "rate_limit_exceeded", type: "tokens" },
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("openai");
    expect(providerError.status).toBe(200);
    expect(providerError.code).toBe("rate_limit_exceeded");
    expect(providerError.type).toBe("tokens");
    expect(providerError.message).toContain("openai request failed (200)");
  });

  it("wraps a fetch rejection in a transport ProviderError", async () => {
    mockFetch(() => Promise.reject(new TypeError("network down")));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect((error as ProviderError).provider).toBe("openai");
  });
});

describe("OpenAIProvider.stream", () => {
  it("yields content deltas parsed from the SSE body", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
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
    expect(body.max_completion_tokens).toBe(64000);
  });

  it("skips blank and non-JSON data lines mid-stream", async () => {
    mockFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data:\n\n",
        "data: not json\n\n",
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
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
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          ),
        );
        // Deliberately leave the stream open so only an early break ends it.
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetch(() => ({ ok: true, body }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
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
      body: sseStream(['data: {"error":{"message":"rate limit"}}\n\n']),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("OpenAI stream error");
  });

  it("throws on a non-2xx response before streaming", async () => {
    mockFetch(() => ({
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
    }));

    const provider = new OpenAIProvider({
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

    await expect(run()).rejects.toThrow("openai request failed (429)");
  });
});
