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

describe("OpenAIProvider.complete", () => {
  it("sends the correct request and returns the message content", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-5.4",
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

    expect(result).toEqual({ text: "Hello, world.", model: "gpt-5.4" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gpt-5.4",
      max_completion_tokens: 16000,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(body.stream).toBeUndefined();
  });

  it("reads the object-form system prompt's text and ignores its cache marker", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
      system: { text: "Be brief.", cacheControl: { ttl: "1h" } },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // OpenAI caches automatically — the marker is dropped, only the text is sent.
    expect(body.messages[0]).toEqual({ role: "system", content: "Be brief." });
  });

  it("merges configured extra headers into the request", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({ model: "gpt-4.1", choices: [{ message: {} }] }),
    }));

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      headers: { "http-referer": "https://example.com", "x-title": "My App" },
    });
    await provider.complete({ messages: [{ role: "user", content: "Hi" }] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
      "http-referer": "https://example.com",
      "x-title": "My App",
    });
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

  it("maps ContentPart[] content onto OpenAI content parts", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
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
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("maps image and file parts onto OpenAI image_url/file parts", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
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
              source: { kind: "url", url: "https://example.com/y.png" },
            },
            {
              type: "file",
              source: {
                kind: "base64",
                mediaType: "application/pdf",
                data: "JVBER",
              },
              filename: "doc.pdf",
            },
          ],
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "What is in these?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      { type: "image_url", image_url: { url: "https://example.com/y.png" } },
      {
        type: "file",
        file: {
          filename: "doc.pdf",
          file_data: "data:application/pdf;base64,JVBER",
        },
      },
    ]);
  });

  it("throws on a URL file source (unsupported by Chat Completions)", async () => {
    mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await expect(
      provider.complete({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                source: { kind: "url", url: "https://example.com/y.pdf" },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("does not support a URL file source");
  });

  it("sends a json_schema response_format and parses structured output", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [{ message: { content: '{"city":"Paris"}' } }],
        }),
    }));

    const schema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    };
    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Where is the Eiffel Tower?" }],
      responseFormat: { type: "json_schema", schema },
    });

    expect(result.parsed).toEqual({ city: "Paris" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // `name` defaults to "response" when omitted; strict mode is on.
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema },
    });
  });

  it("sends tools and maps toolChoice 'any' to 'required'", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: [WEATHER_TOOL],
      toolChoice: "any",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city.",
          parameters: WEATHER_TOOL.parameters,
        },
      },
    ]);
    expect(body.tool_choice).toBe("required");
  });

  it("extracts tool_calls and parses the arguments string", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":"Paris"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Weather?" }],
      tools: [WEATHER_TOOL],
    });

    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("maps tool_use to an assistant tool_calls message and tool_result to a tool message", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.complete({
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "call_1", content: "Sunny" },
          ],
        },
      ],
      tools: [WEATHER_TOOL],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
    ]);
  });

  it("throws a clear error when a tool call or result lacks an id (OpenAI requires it)", async () => {
    mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ model: "gpt-4.1", choices: [] }),
    }));
    const provider = new OpenAIProvider({ apiKey: "sk-test" });

    await expect(
      provider.complete({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "get_weather",
                input: { city: "Paris" },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/requires an id on each tool call/);

    await expect(
      provider.complete({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", content: "Sunny" }],
          },
        ],
      }),
    ).rejects.toThrow(/requires toolUseId/);
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

  it("parses token usage from the response, keeping the provider's total", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("reports cached prompt tokens as a subset of inputTokens", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 5,
            total_tokens: 1005,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    // inputTokens stays = prompt_tokens (cached already inside it).
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 5,
      totalTokens: 1005,
      cachedInputTokens: 800,
    });
  });

  it("clamps an over-reported cached count to inputTokens", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "gpt-4.1",
          choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.usage?.cachedInputTokens).toBe(100);
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

  it("stops at the [DONE] sentinel and ignores anything after it", async () => {
    mockFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data: [DONE]\n\n",
        // A misbehaving server could keep sending after [DONE]; it must be ignored.
        'data: {"choices":[{"delta":{"content":" extra"}}]}\n\n',
      ]),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "Hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(["Hello"]);
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
