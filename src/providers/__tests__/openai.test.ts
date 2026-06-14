import { afterEach, describe, expect, it, jest } from "@jest/globals";

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

  it("throws on a non-2xx response", async () => {
    mockFetch(() => ({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request"),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("OpenAI request failed (400): bad request");
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

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const run = async (): Promise<void> => {
      const sink: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        sink.push(delta);
      }
    };

    await expect(run()).rejects.toThrow("OpenAI request failed (429)");
  });
});
