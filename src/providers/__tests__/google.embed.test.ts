import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../../errors";
import { GoogleProvider } from "../google";

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

describe("GoogleProvider.embed", () => {
  it("sends a batchEmbedContents request and returns vectors and the model", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
        }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    const result = await provider.embed({ input: ["hello", "world"] });

    // Gemini's batch-embed response reports no usage, so it's omitted.
    expect(result).toEqual({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: "gemini-embedding-001",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-goog-api-key": "key-test" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      requests: [
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: "hello" }] },
        },
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: "world" }] },
        },
      ],
    });
  });

  it("sends the model override and outputDimensionality when given", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ embeddings: [{ values: [1] }] }),
    }));

    const provider = new GoogleProvider({ apiKey: "key-test" });
    await provider.embed({
      input: ["x"],
      model: "text-embedding-004",
      dimensions: 128,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/models/text-embedding-004:batchEmbedContents");
    const body = JSON.parse(init.body as string);
    expect(body.requests[0]).toEqual({
      model: "models/text-embedding-004",
      content: { parts: [{ text: "x" }] },
      outputDimensionality: 128,
    });
  });

  it("throws a ProviderError on a non-2xx response", async () => {
    mockFetch(() => ({
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
      json: () => Promise.resolve({}),
    }));

    const provider = new GoogleProvider({
      apiKey: "key-test",
      retry: { maxRetries: 0 },
    });
    await expect(provider.embed({ input: ["x"] })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
