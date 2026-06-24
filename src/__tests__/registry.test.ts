import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { type StrategyName } from "../combine";
import { ProviderRegistry } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
} from "../types";

const PROMPT = {
  messages: [{ role: "user" as const, content: "What is 2 + 2?" }],
};

describe("ProviderRegistry", () => {
  it("constructs and selects a configured provider by name", () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "k" } });

    expect(registry.select("anthropic").name).toBe("anthropic");
  });

  it("constructs every configured provider", () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
      google: { apiKey: "g" },
    });

    expect(registry.select("anthropic").name).toBe("anthropic");
    expect(registry.select("openai").name).toBe("openai");
    expect(registry.select("google").name).toBe("google");
    expect(registry.names()).toEqual(["anthropic", "openai", "google"]);
  });

  it("only registers providers present in the config", () => {
    const registry = new ProviderRegistry({ openai: { apiKey: "o" } });

    expect(registry.has("openai")).toBe(true);
    expect(registry.has("anthropic")).toBe(false);
    expect(registry.names()).toEqual(["openai"]);
  });

  it("returns names in a fixed order regardless of config key order", () => {
    const registry = new ProviderRegistry({
      google: { apiKey: "g" },
      openai: { apiKey: "o" },
      anthropic: { apiKey: "a" },
    });

    expect(registry.names()).toEqual(["anthropic", "openai", "google"]);
  });

  it("throws when selecting a provider that wasn't configured, listing the configured ones", () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    expect(() => registry.select("openai")).toThrow(
      'No provider "openai" configured. Configured: anthropic',
    );
  });

  it("lists (none) when nothing is configured", () => {
    const registry = new ProviderRegistry({});

    expect(() => registry.select("anthropic")).toThrow(
      'No provider "anthropic" configured. Configured: (none)',
    );
  });
});

describe("ProviderRegistry custom providers", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetch(impl: (...args: any[]) => any): jest.Mock {
    const fn = jest.fn(impl);
    (globalThis as any).fetch = fn;
    return fn;
  }

  it("registers and selects a bring-your-own Provider instance", () => {
    const custom: Provider = {
      name: "my-llm",
      complete: () => Promise.resolve({ text: "hi", model: "m" }),
      stream: () => {
        throw new Error("stream not used in this test");
      },
    };
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      custom: { mine: { kind: "provider", provider: custom } },
    });

    // The exact instance is handed back, and it lists after the built-ins.
    expect(registry.select("mine")).toBe(custom);
    expect(registry.has("mine")).toBe(true);
    expect(registry.names()).toEqual(["anthropic", "mine"]);
  });

  it("registers an OpenAI-compatible gateway and threads baseUrl/model/headers through", async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "llama-3.3-70b",
          choices: [{ message: { content: "ok" } }],
        }),
    }));

    const registry = new ProviderRegistry({
      custom: {
        groq: {
          kind: "openai-compatible",
          apiKey: "gk",
          baseUrl: "https://api.groq.com/openai",
          model: "llama-3.3-70b",
          headers: { "x-extra": "1" },
        },
      },
    });

    // The alias name carries onto the provider (not the internal "openai").
    expect(registry.select("groq").name).toBe("groq");

    const result = await registry
      .select("groq")
      .complete({ messages: [{ role: "user", content: "Hi" }] });
    expect(result.text).toBe("ok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer gk",
      "x-extra": "1",
    });
    expect(JSON.parse(init.body as string).model).toBe("llama-3.3-70b");
  });

  it('attributes an OpenAI-compatible gateway\'s errors to its alias name, not "openai"', async () => {
    mockFetch(() => ({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
      headers: new Headers(),
    }));

    const registry = new ProviderRegistry({
      custom: {
        groq: {
          kind: "openai-compatible",
          apiKey: "bad",
          baseUrl: "https://api.groq.com/openai",
          model: "llama-3.3-70b",
        },
      },
    });

    await expect(
      registry
        .select("groq")
        .complete({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toMatchObject({ provider: "groq" });
  });

  it("throws when a custom name collides with a built-in", () => {
    expect(
      () =>
        new ProviderRegistry({
          custom: {
            openai: {
              kind: "openai-compatible",
              apiKey: "k",
              baseUrl: "https://example.com",
              model: "m",
            },
          },
        }),
    ).toThrow(/collides with a built-in/);
  });
});

describe("ProviderRegistry.combine", () => {
  it("throws when no participants are given", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "k" } });

    await expect(
      registry.combine({ ...PROMPT, participants: [] }),
    ).rejects.toThrow(/at least one participant/);
  });

  it("throws when the synthesizer is not among the participants", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic"],
        synthesizer: "openai",
      }),
    ).rejects.toThrow(/must be one of the participants/);
  });

  it("throws on duplicate participants", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "anthropic"],
      }),
    ).rejects.toThrow(/must be unique/);
  });

  it("throws on an empty messages array", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(
      registry.combine({ messages: [], participants: ["anthropic"] }),
    ).rejects.toThrow(/at least one message/);
  });

  it("throws on a non-positive minParticipants", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        minParticipants: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it("throws when minParticipants exceeds the participant count", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        minParticipants: 3,
      }),
    ).rejects.toThrow(/cannot exceed/);
  });

  it("throws on an unknown strategy", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic"],
        strategy: "court" as unknown as StrategyName,
      }),
    ).rejects.toThrow(/Unknown combine strategy/);
  });

  it("throws when the ensemble strategy is given no responseFormat", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        strategy: "ensemble",
      }),
    ).rejects.toThrow(/ensemble.*requires a responseFormat/);
  });

  it("rejects responseFormat on a non-ensemble strategy", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });
    const responseFormat = {
      type: "json_schema" as const,
      schema: { type: "object", additionalProperties: false },
    };

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        strategy: "consensus",
        responseFormat,
      }),
    ).rejects.toThrow(/only supported by the "ensemble" strategy/);

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        strategy: "pipeline",
        responseFormat,
      }),
    ).rejects.toThrow(/only supported by the "ensemble" strategy/);

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        strategy: "broadcast",
        responseFormat,
      }),
    ).rejects.toThrow(/only supported by the "ensemble" strategy/);
  });

  it("rejects a non-object-root schema for the ensemble strategy", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        strategy: "ensemble",
        responseFormat: {
          type: "json_schema",
          schema: { type: "array", items: { type: "string" } },
        },
      }),
    ).rejects.toThrow(/requires an object schema/);
  });

  it("rejects tools/toolChoice — combine does not do tool calling", async () => {
    const registry = new ProviderRegistry({
      anthropic: { apiKey: "a" },
      openai: { apiKey: "o" },
    });
    const tool = {
      name: "get_weather",
      parameters: { type: "object", additionalProperties: false },
    };

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        tools: [tool],
      }),
    ).rejects.toThrow(/does not support tool calling/);

    await expect(
      registry.combine({
        ...PROMPT,
        participants: ["anthropic", "openai"],
        toolChoice: "auto",
      }),
    ).rejects.toThrow(/does not support tool calling/);
  });

  it("throws when two participants resolve to the same label", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: [
          { provider: "anthropic", model: "m" },
          { provider: "anthropic", model: "m" },
        ],
      }),
    ).rejects.toThrow(/labels must be unique/);
  });

  it("throws on an empty per-participant model", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: [{ provider: "anthropic", model: "" }],
      }),
    ).rejects.toThrow(/empty model/);
  });

  it("throws on a non-positive per-participant maxTokens", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(
      registry.combine({
        ...PROMPT,
        participants: [{ provider: "anthropic", maxTokens: 0 }],
      }),
    ).rejects.toThrow(/maxTokens/);
  });

  it("runs the same provider twice with different per-participant models", async () => {
    // A bring-your-own provider that echoes the per-call model lets us assert each
    // participant's model override threads through to its completion.
    const calls: CompletionRequest[] = [];
    const echoModel: Provider = {
      name: "mine",
      complete: (request: CompletionRequest): Promise<CompletionResult> => {
        calls.push(request);
        return Promise.resolve({ text: "answer", model: request.model ?? "?" });
      },
      stream: () => {
        throw new Error("stream not used in this test");
      },
    };
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echoModel } },
    });

    const result = await registry.combine({
      ...PROMPT,
      strategy: "pipeline",
      participants: [
        { provider: "mine", model: "fast" },
        { provider: "mine", model: "smart" },
      ],
    });

    // Two stages on the one provider, each with its own model override; labels are
    // auto-derived as `<provider>-<model>`, so they don't collide.
    expect(calls.map((c) => c.model)).toEqual(["fast", "smart"]);
    // `combine({ strategy: "pipeline" })` is typed `PipelineResult` — no narrowing.
    expect(result.finalParticipant).toBe("mine-smart");
  });

  it("dispatches the broadcast strategy and returns every raw response", async () => {
    const echo: Provider = {
      name: "mine",
      complete: (req: CompletionRequest): Promise<CompletionResult> =>
        Promise.resolve({ text: `${req.model ?? "?"} says hi`, model: "m" }),
      stream: () => {
        throw new Error("stream not used in this test");
      },
    };
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echo } },
    });

    const result = await registry.combine({
      ...PROMPT,
      strategy: "broadcast",
      participants: [
        { provider: "mine", model: "fast" },
        { provider: "mine", model: "smart" },
      ],
    });

    // `combine({ strategy: "broadcast" })` is typed `BroadcastResult` — no narrowing.
    expect(result.responses.map((o) => o.id)).toEqual([
      "mine-fast",
      "mine-smart",
    ]);
    expect(
      result.responses.map((o) => (o.status === "ok" ? o.result.text : null)),
    ).toEqual(["fast says hi", "smart says hi"]);
  });

  it("accepts a budget on every strategy (incl. the fan-out ones)", async () => {
    const echo: Provider = {
      name: "mine",
      complete: (): Promise<CompletionResult> =>
        Promise.resolve({ text: "hi", model: "m" }),
      stream: () => {
        throw new Error("stream not used in this test");
      },
    };
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echo } },
    });
    const participants = [
      { provider: "mine", model: "a" },
      { provider: "mine", model: "b" },
    ];

    // No strategy rejects `budget` — it's informational on the fan-out strategies.
    for (const strategy of ["consensus", "pipeline", "broadcast"] as const) {
      await expect(
        registry.combine(
          { ...PROMPT, strategy, participants },
          { budget: { usd: 1 } },
        ),
      ).resolves.toBeDefined();
    }
  });
});

describe("ProviderRegistry per-strategy methods", () => {
  const echo: Provider = {
    name: "mine",
    complete: (req: CompletionRequest): Promise<CompletionResult> =>
      Promise.resolve({ text: `${req.model ?? "?"} says hi`, model: "m" }),
    stream: () => {
      throw new Error("stream not used in this test");
    },
  };

  it("broadcast() returns a typed BroadcastResult without narrowing", async () => {
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echo } },
    });

    // The method's return type is BroadcastResult, so `responses` is reachable
    // without narrowing a union.
    const result = await registry.broadcast({
      ...PROMPT,
      participants: [
        { provider: "mine", model: "fast" },
        { provider: "mine", model: "smart" },
      ],
    });

    expect(result.strategy).toBe("broadcast");
    expect(result.responses.map((o) => o.id)).toEqual([
      "mine-fast",
      "mine-smart",
    ]);
  });

  it("pipeline() returns a typed PipelineResult and runs each stage's model", async () => {
    const calls: CompletionRequest[] = [];
    const echoModel: Provider = {
      name: "mine",
      complete: (request: CompletionRequest): Promise<CompletionResult> => {
        calls.push(request);
        return Promise.resolve({ text: "answer", model: request.model ?? "?" });
      },
      stream: () => {
        throw new Error("stream not used in this test");
      },
    };
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echoModel } },
    });

    const result = await registry.pipeline({
      ...PROMPT,
      participants: [
        { provider: "mine", model: "fast" },
        { provider: "mine", model: "smart" },
      ],
    });

    expect(calls.map((c) => c.model)).toEqual(["fast", "smart"]);
    expect(result.finalParticipant).toBe("mine-smart");
  });

  it("shares the cross-cutting validation (e.g. rejects an empty roster)", async () => {
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echo } },
    });

    await expect(
      registry.pipeline({ ...PROMPT, participants: [] }),
    ).rejects.toThrow(/at least one participant/);
  });

  it("broadcast rejects an embedding provider that doesn't support embeddings", async () => {
    const registry = new ProviderRegistry({
      custom: { mine: { kind: "provider", provider: echo } },
    });

    // `echo` has no `embed`, so resolving it as the embedder throws up front.
    await expect(
      registry.broadcast(
        { ...PROMPT, participants: ["mine"] },
        { embedding: { provider: "mine" } },
      ),
    ).rejects.toThrow('Provider "mine" does not support embeddings.');
  });

  it("broadcast attaches a semantic comparison from the configured embedder", async () => {
    const answerer: Provider = {
      name: "answerer",
      complete: (req: CompletionRequest): Promise<CompletionResult> =>
        Promise.resolve({ text: req.model ?? "?", model: "m" }),
      stream: () => {
        throw new Error("stream not used in this test");
      },
    };
    const embedder: Provider = {
      ...answerer,
      name: "embedder",
      embed: (req: EmbeddingRequest): Promise<EmbeddingResult> =>
        Promise.resolve({
          // Distinct vectors per input so there are two clusters.
          embeddings: req.input.map((_, i) => (i === 0 ? [1, 0] : [0, 1])),
          model: "embed-model",
        }),
    };
    const registry = new ProviderRegistry({
      custom: {
        answerer: { kind: "provider", provider: answerer },
        embedder: { kind: "provider", provider: embedder },
      },
    });

    const result = await registry.broadcast(
      {
        ...PROMPT,
        participants: [
          { provider: "answerer", model: "a" },
          { provider: "answerer", model: "b" },
        ],
      },
      { embedding: { provider: "embedder" } },
    );

    expect(result.semantic).toBeDefined();
    expect(result.semantic?.clusters).toEqual([["answerer-a"], ["answerer-b"]]);
  });
});

describe("ProviderRegistry.embed / embedMany", () => {
  const calls: EmbeddingRequest[] = [];
  const embedder: Provider = {
    name: "embedder",
    complete: () => {
      throw new Error("complete not used in this test");
    },
    stream: () => {
      throw new Error("stream not used in this test");
    },
    embed: (request: EmbeddingRequest): Promise<EmbeddingResult> => {
      calls.push(request);
      return Promise.resolve({
        embeddings: request.input.map((_, i) => [i, i + 1]),
        model: request.model ?? "default-embed",
        usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 },
      });
    },
  };

  afterEach(() => {
    calls.length = 0;
  });

  it("embedMany returns one vector per input and threads options through", async () => {
    const registry = new ProviderRegistry({
      custom: { e: { kind: "provider", provider: embedder } },
    });

    const result = await registry.embedMany("e", ["a", "b"], {
      model: "m",
      dimensions: 2,
    });

    expect(result.embeddings).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(result.model).toBe("m");
    expect(calls[0]).toEqual({ input: ["a", "b"], model: "m", dimensions: 2 });
  });

  it("embed returns the single vector", async () => {
    const registry = new ProviderRegistry({
      custom: { e: { kind: "provider", provider: embedder } },
    });

    const result = await registry.embed("e", "hello");

    expect(result.embedding).toEqual([0, 1]);
    expect(result.model).toBe("default-embed");
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 0,
      totalTokens: 3,
    });
  });

  it("throws when the provider isn't configured", async () => {
    const registry = new ProviderRegistry({
      custom: { e: { kind: "provider", provider: embedder } },
    });

    await expect(registry.embed("nope", "x")).rejects.toThrow(
      'No provider "nope" configured',
    );
  });

  it("throws when the provider doesn't support embeddings", async () => {
    const registry = new ProviderRegistry({ anthropic: { apiKey: "a" } });

    await expect(registry.embed("anthropic", "x")).rejects.toThrow(
      'Provider "anthropic" does not support embeddings.',
    );
    await expect(registry.embedMany("anthropic", ["x"])).rejects.toThrow(
      'Provider "anthropic" does not support embeddings.',
    );
  });
});
