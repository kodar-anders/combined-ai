import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../../errors";
import { OpenAIProvider } from "../openai";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (...args: any[]) => any): jest.Mock {
  const fn = jest.fn(impl);
  (globalThis as any).fetch = fn;
  return fn;
}

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("OpenAIProvider.embed", () => {
  it("sends the correct request and returns vectors, model, and usage", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "text-embedding-3-small",
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.3, 0.4] },
          ],
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.embed({ input: ["hello", "world"] });

    expect(result).toEqual({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: "text-embedding-3-small",
      usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello", "world"],
    });
  });

  it("orders vectors by index even when the response is out of order", async () => {
    mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "text-embedding-3-small",
          data: [
            { index: 1, embedding: [0.3, 0.4] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
        }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.embed({ input: ["a", "b"] });

    expect(result.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("sends the model override and dimensions when given", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: [1] }] }),
    }));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.embed({
      input: ["x"],
      model: "text-embedding-3-large",
      dimensions: 256,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "text-embedding-3-large",
      input: ["x"],
      dimensions: 256,
    });
  });

  it("throws a ProviderError on a non-2xx response", async () => {
    mockFetch(() => ({
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
      json: () => Promise.resolve({}),
    }));

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      retry: { maxRetries: 0 },
    });
    await expect(provider.embed({ input: ["x"] })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
