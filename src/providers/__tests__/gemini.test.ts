import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../../errors";
import { GeminiProvider } from "../gemini";

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

describe("GeminiProvider.complete", () => {
  it("sends the correct request and returns the candidate text", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Hello, world." }] },
            },
          ],
        }),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      system: "Be brief.",
    });

    expect(result).toEqual({ text: "Hello, world.", model: "gemini-2.5-pro" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-goog-api-key": "key-test",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      generationConfig: { maxOutputTokens: 16000 },
      systemInstruction: { parts: [{ text: "Be brief." }] },
    });
  });

  it("omits systemInstruction when no system prompt is given and maps the assistant role to model", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Bye" },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toBeUndefined();
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello" }] },
      { role: "user", parts: [{ text: "Bye" }] },
    ]);
  });

  it("honors an explicit model and maxTokens", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-flash", candidates: [] }),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      model: "gemini-2.5-flash",
      maxTokens: 100,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  it("throws a typed ProviderError parsing the Gemini error body", async () => {
    mockFetch(() => ({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          '{"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}}',
        ),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("gemini");
    expect(providerError.status).toBe(400);
    // Gemini's numeric `code` is skipped; its `status` becomes the error `type`.
    expect(providerError.code).toBeUndefined();
    expect(providerError.type).toBe("INVALID_ARGUMENT");
  });

  it("wraps a fetch rejection in a transport ProviderError", async () => {
    mockFetch(() => Promise.reject(new TypeError("network down")));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect((error as ProviderError).provider).toBe("gemini");
  });
});

describe("GeminiProvider.stream", () => {
  it("yields text deltas parsed from the SSE body", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel',
        'lo"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n',
      ]),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "Hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(["Hello", " world"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(64000);
  });

  it("skips blank and non-JSON data lines mid-stream", async () => {
    mockFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
        "data:\n\n",
        "data: not json\n\n",
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n',
      ]),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
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
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
          ),
        );
        // Deliberately leave the stream open so only an early break ends it.
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetch(() => ({ ok: true, body }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
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
      body: sseStream(['data: {"error":{"message":"quota"}}\n\n']),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("Gemini stream error");
  });

  it("throws on a non-2xx response before streaming", async () => {
    mockFetch(() => ({
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
    }));

    const provider = new GeminiProvider({ apiKey: "key-test" });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("gemini request failed (429)");
  });
});
