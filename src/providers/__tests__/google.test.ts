import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../../errors";
import { GoogleProvider } from "../google";

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

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

describe("GoogleProvider.complete", () => {
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

    const provider = new GoogleProvider({ apiKey: "key-test" });
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

  it("reads the object-form system prompt's text and ignores its cache marker", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "Hi" }] } },
          ],
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      system: { text: "Be brief.", cacheControl: { ttl: "1h" } },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // Gemini caches implicitly — the marker is dropped, only the text is sent.
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
  });

  it("omits systemInstruction when no system prompt is given and maps the assistant role to model", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
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

    const provider = new GoogleProvider({ apiKey: "key-test" });
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

  it("maps ContentPart[] content onto Gemini text parts", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "first" }, { text: "second" }] },
    ]);
  });

  it("maps image and file parts onto Gemini inlineData/fileData", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in these?" },
            {
              type: "image",
              source: { kind: "base64", mediaType: "image/png", data: "aGk=" },
            },
            {
              type: "image",
              source: {
                kind: "url",
                url: "https://example.com/y.png",
                mediaType: "image/png",
              },
            },
            {
              type: "image",
              source: { kind: "url", url: "https://example.com/no-mime" },
            },
            {
              type: "file",
              source: {
                kind: "base64",
                mediaType: "application/pdf",
                data: "JVBER",
              },
            },
          ],
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts).toEqual([
      { text: "What is in these?" },
      { inlineData: { mimeType: "image/png", data: "aGk=" } },
      {
        fileData: {
          mimeType: "image/png",
          fileUri: "https://example.com/y.png",
        },
      },
      { fileData: { fileUri: "https://example.com/no-mime" } },
      { inlineData: { mimeType: "application/pdf", data: "JVBER" } },
    ]);
  });

  it("sends responseSchema with UPPERCASE types and parses structured output", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [{ content: { parts: [{ text: '{"city":"Paris"}' }] } }],
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Where is the Eiffel Tower?" }],
      responseFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    });

    expect(result.parsed).toEqual({ city: "Paris" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({
      type: "OBJECT",
      properties: { city: { type: "STRING" } },
      required: ["city"],
    });
  });

  it("sends functionDeclarations (UPPERCASE param types) and toolConfig", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: [WEATHER_TOOL],
      toolChoice: { name: "get_weather" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get the weather for a city.",
            parameters: {
              type: "OBJECT",
              properties: { city: { type: "STRING" } },
              required: ["city"],
            },
          },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["get_weather"],
      },
    });
  });

  it("extracts functionCall parts as toolCalls and overrides finishReason to tool_use", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "get_weather",
                      args: { city: "Paris" },
                    },
                  },
                ],
              },
            },
          ],
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Weather?" }],
      tools: [WEATHER_TOOL],
    });

    expect(result.finishReason).toBe("tool_use");
    expect(result.rawFinishReason).toBe("STOP");
    expect(result.toolCalls).toEqual([
      { name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("maps tool_use to a functionCall part and tool_result to a functionResponse part", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "fc_1",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "fc_1",
              name: "get_weather",
              content: "Sunny",
            },
          ],
        },
      ],
      tools: [WEATHER_TOOL],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.contents).toEqual([
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "get_weather",
              id: "fc_1",
              args: { city: "Paris" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "get_weather",
              id: "fc_1",
              response: { result: "Sunny" },
            },
          },
        ],
      },
    ]);
  });

  it("does not mask a MAX_TOKENS stop with tool_use when a functionCall is present", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            {
              // A truncated tool call: the function-call part exists but the stop
              // reason is MAX_TOKENS, which must not be reported as a clean tool_use.
              finishReason: "MAX_TOKENS",
              content: {
                parts: [{ functionCall: { name: "get_weather", args: {} } }],
              },
            },
          ],
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Weather?" }],
      tools: [WEATHER_TOOL],
    });

    expect(result.finishReason).toBe("length");
    expect(result.rawFinishReason).toBe("MAX_TOKENS");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("throws when a tool_result has no name (Gemini matches by name)", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await expect(
      provider.complete({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "fc_1", content: "Sunny" },
            ],
          },
        ],
        tools: [WEATHER_TOOL],
      }),
    ).rejects.toThrow(/requires the tool name/);
  });

  it("forwards an abort signal to fetch", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ modelVersion: "gemini-2.5-pro", candidates: [] }),
    }));

    const controller = new AbortController();
    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("maps MAX_TOKENS onto finishReason length", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            { finishReason: "MAX_TOKENS", content: { parts: [{ text: "" }] } },
          ],
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("length");
    expect(result.rawFinishReason).toBe("MAX_TOKENS");
  });

  it("falls back to promptFeedback.blockReason when the prompt is blocked", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          promptFeedback: { blockReason: "SAFETY" },
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.finishReason).toBe("content_filter");
    expect(result.rawFinishReason).toBe("SAFETY");
  });

  it("parses usageMetadata, keeping the thinking-inclusive total verbatim", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "Hi" }] } },
          ],
          // totalTokenCount exceeds prompt + candidates because it includes
          // thinking tokens; we keep the provider's own total.
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 42,
          },
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 42,
    });
  });

  it("reports cachedContentTokenCount as a subset of inputTokens", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          modelVersion: "gemini-2.5-pro",
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "Hi" }] } },
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 5,
            totalTokenCount: 1005,
            cachedContentTokenCount: 800,
          },
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    // inputTokens stays = promptTokenCount (cached already inside it).
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 5,
      totalTokens: 1005,
      cachedInputTokens: 800,
    });
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

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("google");
    expect(providerError.status).toBe(400);
    // Gemini's numeric `code` is skipped; its `status` becomes the error `type`.
    expect(providerError.code).toBeUndefined();
    expect(providerError.type).toBe("INVALID_ARGUMENT");
  });

  it("throws a typed ProviderError on a 200 response with an error body", async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          error: { code: 503, message: "overloaded", status: "UNAVAILABLE" },
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe("api");
    expect(providerError.provider).toBe("google");
    expect(providerError.status).toBe(200);
    expect(providerError.type).toBe("UNAVAILABLE");
    expect(providerError.message).toContain("google request failed (200)");
  });

  it("wraps a fetch rejection in a transport ProviderError", async () => {
    mockFetch(() => Promise.reject(new TypeError("network down")));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const error = await provider
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect((error as ProviderError).provider).toBe("google");
  });
});

describe("GoogleProvider.stream", () => {
  it("yields text deltas parsed from the SSE body", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel',
        'lo"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n',
      ]),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
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

    const provider = new GoogleProvider({ apiKey: "key-test" });
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

    const provider = new GoogleProvider({ apiKey: "key-test" });
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

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("Google stream error");
  });

  it("throws on a non-2xx response before streaming", async () => {
    mockFetch(() => ({
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
    }));

    const provider = new GoogleProvider({
      apiKey: "key-test",
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

    await expect(run()).rejects.toThrow("google request failed (429)");
  });
});
