import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { ProviderError } from "../errors";
import { type FallbackEvent } from "../fallback";
import { OpenAIProvider } from "../providers/openai";
import { ProviderRegistry } from "../registry";
import { MockProvider } from "../testing/mock-provider";
import { type Provider } from "../types";

const PROMPT = {
  messages: [{ role: "user" as const, content: "What is 2 + 2?" }],
};

/** A ProviderError like a provider being down (retries already exhausted). */
function down(provider: string, status = 503): ProviderError {
  return new ProviderError(`${provider} unavailable`, {
    provider,
    kind: "api",
    status,
  });
}

/** Build a registry from a map of custom-name → provider. */
function registryOf(providers: Record<string, Provider>): ProviderRegistry {
  const custom = Object.fromEntries(
    Object.entries(providers).map(([name, provider]) => [
      name,
      { kind: "provider" as const, provider },
    ]),
  );
  return new ProviderRegistry({ custom });
}

describe("registry.fallback — construction", () => {
  it("throws on an empty chain", () => {
    const registry = registryOf({ p1: new MockProvider() });

    expect(() => registry.fallback([])).toThrow(
      "fallback requires at least one provider",
    );
  });

  it("throws when a chain names a provider that isn't configured", () => {
    const registry = registryOf({ p1: new MockProvider() });

    expect(() => registry.fallback(["p1", "nope"])).toThrow(
      'No provider "nope" configured',
    );
  });

  it("rejects an empty per-entry model", () => {
    const registry = registryOf({ p1: new MockProvider() });

    expect(() => registry.fallback([{ provider: "p1", model: "  " }])).toThrow(
      /empty model/,
    );
  });

  it("rejects a non-positive per-entry maxTokens", () => {
    const registry = registryOf({ p1: new MockProvider() });

    expect(() => registry.fallback([{ provider: "p1", maxTokens: 0 }])).toThrow(
      /invalid maxTokens/,
    );
  });

  it("names the returned provider after the chain", () => {
    const registry = registryOf({
      p1: new MockProvider(),
      p2: new MockProvider(),
    });

    expect(registry.fallback(["p1", "p2"]).name).toBe("fallback(p1->p2)");
  });
});

describe("registry.fallback — complete()", () => {
  it("returns the primary's result without touching the rest", async () => {
    const primary = new MockProvider({ response: "primary answer" });
    const secondary = new MockProvider({ response: "secondary answer" });
    const onFallback = jest.fn();
    const registry = registryOf({ primary, secondary });

    const result = await registry
      .fallback(["primary", "secondary"], { onFallback })
      .complete(PROMPT);

    expect(result.text).toBe("primary answer");
    expect(secondary.calls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back to the next provider on a ProviderError", async () => {
    const primary = new MockProvider({ response: down("primary") });
    const secondary = new MockProvider({ response: "secondary answer" });
    const registry = registryOf({ primary, secondary });

    const result = await registry
      .fallback(["primary", "secondary"])
      .complete(PROMPT);

    expect(result.text).toBe("secondary answer");
    expect(primary.calls).toHaveLength(1);
  });

  it("falls back on a plain transport failure with no signal", async () => {
    const primary = new MockProvider({
      response: new ProviderError("network down", {
        provider: "primary",
        kind: "transport",
        cause: new Error("ECONNRESET"),
      }),
    });
    const secondary = new MockProvider({ response: "ok" });
    const registry = registryOf({ primary, secondary });

    const result = await registry
      .fallback(["primary", "secondary"])
      .complete(PROMPT);

    expect(result.text).toBe("ok");
  });

  it("aggregates every cause when all providers fail", async () => {
    const providers = {
      p1: new MockProvider({ response: down("p1") }),
      p2: new MockProvider({ response: down("p2") }),
      p3: new MockProvider({ response: down("p3") }),
    };
    const registry = registryOf(providers);

    const error = await registry
      .fallback(["p1", "p2", "p3"])
      .complete(PROMPT)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toContain("p1, p2, p3");
    expect(aggregate.errors).toHaveLength(3);
    expect(
      (aggregate.errors as ProviderError[]).map((e) => e.provider),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("still yields an AggregateError for a single-provider chain that fails", async () => {
    const registry = registryOf({
      p1: new MockProvider({ response: down("p1") }),
    });

    const error = await registry
      .fallback(["p1"])
      .complete(PROMPT)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(1);
  });

  it("propagates a non-ProviderError immediately without falling back", async () => {
    const primary = new MockProvider({ response: new Error("bug in my code") });
    const secondary = new MockProvider({ response: "ok" });
    const registry = registryOf({ primary, secondary });

    await expect(
      registry.fallback(["primary", "secondary"]).complete(PROMPT),
    ).rejects.toThrow("bug in my code");
    expect(secondary.calls).toHaveLength(0);
  });

  it("does not advance the chain when the signal was aborted", async () => {
    const primary = new MockProvider({ response: "unused" });
    const secondary = new MockProvider({ response: "ok" });
    const registry = registryOf({ primary, secondary });
    const controller = new AbortController();
    controller.abort();

    const error = await registry
      .fallback(["primary", "secondary"])
      .complete({ ...PROMPT, signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect(secondary.calls).toHaveLength(0);
  });

  it("fires onFallback for each advance (N-1 times) with the right index", async () => {
    const registry = registryOf({
      p1: new MockProvider({ response: down("p1") }),
      p2: new MockProvider({ response: down("p2") }),
      p3: new MockProvider({ response: down("p3") }),
    });
    const events: FallbackEvent[] = [];

    await expect(
      registry
        .fallback(["p1", "p2", "p3"], { onFallback: (e) => events.push(e) })
        .complete(PROMPT),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(events.map((e) => [e.index, e.provider])).toEqual([
      [0, "p1"],
      [1, "p2"],
    ]);
  });

  it("propagates the error directly when shouldFallback returns false", async () => {
    const primary = new MockProvider({ response: down("primary", 400) });
    const secondary = new MockProvider({ response: "ok" });
    const registry = registryOf({ primary, secondary });
    const shouldFallback = jest.fn(
      (event: FallbackEvent) => event.error.status !== 400,
    );

    const error = await registry
      .fallback(["primary", "secondary"], { shouldFallback })
      .complete(PROMPT)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect(secondary.calls).toHaveLength(0);
    expect(shouldFallback).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, provider: "primary" }),
    );
  });

  it("surfaces the last provider's error directly when shouldFallback vetoes it", async () => {
    const primary = new MockProvider({ response: down("primary", 503) });
    const secondary = new MockProvider({ response: down("secondary", 401) });
    const registry = registryOf({ primary, secondary });

    const error = await registry
      .fallback(["primary", "secondary"], {
        shouldFallback: ({ error }) => error.status !== 401,
      })
      .complete(PROMPT)
      .catch((e: unknown) => e);

    // The 401 is on the last entry — it must surface raw, not wrapped in an
    // AggregateError, so `err.status === 401` handling still works.
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect((error as ProviderError).status).toBe(401);
  });

  it("applies per-entry model/maxTokens overrides", async () => {
    const p1 = new MockProvider({ response: "ok" });
    const registry = registryOf({ p1 });

    await registry
      .fallback([{ provider: "p1", model: "custom-model", maxTokens: 99 }])
      .complete(PROMPT);

    expect(p1.calls[0]?.model).toBe("custom-model");
    expect(p1.calls[0]?.maxTokens).toBe(99);
  });

  it("falls through to request-level model/maxTokens when the entry omits them", async () => {
    const p1 = new MockProvider({ response: "ok" });
    const registry = registryOf({ p1 });

    await registry
      .fallback(["p1"])
      .complete({ ...PROMPT, model: "req-model", maxTokens: 50 });

    expect(p1.calls[0]?.model).toBe("req-model");
    expect(p1.calls[0]?.maxTokens).toBe(50);
  });

  it("forwards the full request (tools, responseFormat) to the selected provider", async () => {
    const p1 = new MockProvider({ response: "ok" });
    const registry = registryOf({ p1 });
    const tools = [{ name: "lookup", parameters: { type: "object" } }];
    const responseFormat = {
      type: "json_schema" as const,
      schema: { type: "object" },
    };

    await registry
      .fallback(["p1"])
      .complete({ ...PROMPT, tools, responseFormat });

    expect(p1.calls[0]?.tools).toEqual(tools);
    expect(p1.calls[0]?.responseFormat).toEqual(responseFormat);
  });
});

describe("registry.fallback — stream()", () => {
  async function collect(stream: AsyncIterable<string>): Promise<string[]> {
    const deltas: string[] = [];
    for await (const delta of stream) {
      deltas.push(delta);
    }
    return deltas;
  }

  it("falls back when the primary fails before the first delta", async () => {
    const primary = new MockProvider({ response: down("primary") });
    const secondary = new MockProvider({ response: "hello world" });
    const registry = registryOf({ primary, secondary });

    const deltas = await collect(
      registry.fallback(["primary", "secondary"]).stream(PROMPT),
    );

    expect(deltas.join("")).toBe("hello world");
  });

  it("treats an empty (zero-delta) primary as success and does not fall back", async () => {
    const primary = new MockProvider({ response: "" });
    const secondary = new MockProvider({ response: "secondary" });
    const registry = registryOf({ primary, secondary });

    const deltas = await collect(
      registry.fallback(["primary", "secondary"]).stream(PROMPT),
    );

    expect(deltas).toEqual([]);
    expect(secondary.calls).toHaveLength(0);
  });

  it("does not advance the chain when the signal was aborted", async () => {
    const primary = new MockProvider({ response: "unused" });
    const secondary = new MockProvider({ response: "ok" });
    const registry = registryOf({ primary, secondary });
    const controller = new AbortController();
    controller.abort();

    const error = await collect(
      registry
        .fallback(["primary", "secondary"])
        .stream({ ...PROMPT, signal: controller.signal }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(secondary.calls).toHaveLength(0);
  });

  it("does not fall back once a delta has been emitted", async () => {
    const primary: Provider = {
      name: "primary",
      complete: () => Promise.reject(new Error("unused")),
      async *stream() {
        await Promise.resolve();
        yield "partial ";
        throw down("primary", 500);
      },
    };
    const secondary = new MockProvider({ response: "backup" });
    const registry = registryOf({ primary, secondary });

    const deltas: string[] = [];
    const error = await (async () => {
      for await (const delta of registry
        .fallback(["primary", "secondary"])
        .stream(PROMPT)) {
        deltas.push(delta);
      }
    })().catch((e: unknown) => e);

    expect(deltas).toEqual(["partial "]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(secondary.calls).toHaveLength(0);
  });

  it("closes the inner stream when the consumer breaks early", async () => {
    let closed = false;
    const primary: Provider = {
      name: "primary",
      complete: () => Promise.reject(new Error("unused")),
      async *stream() {
        await Promise.resolve();
        try {
          yield "a";
          yield "b";
        } finally {
          closed = true;
        }
      },
    };
    const registry = registryOf({ primary });

    const deltas: string[] = [];
    for await (const delta of registry.fallback(["primary"]).stream(PROMPT)) {
      deltas.push(delta);
      break;
    }

    expect(deltas).toEqual(["a"]);
    expect(closed).toBe(true);
  });

  it("falls back when a provider's stream() throws synchronously", async () => {
    // The Provider contract only promises an AsyncIterable, so a BYO provider may
    // throw before returning one — that must be eligible for fallback like complete().
    const primary: Provider = {
      name: "primary",
      complete: () => Promise.reject(new Error("unused")),
      stream(): AsyncIterable<string> {
        throw down("primary", 500);
      },
    };
    const secondary = new MockProvider({ response: "backup" });
    const registry = registryOf({ primary, secondary });

    const deltas = await collect(
      registry.fallback(["primary", "secondary"]).stream(PROMPT),
    );

    expect(deltas.join("")).toBe("backup");
  });

  it("does not let a throwing teardown mask an early consumer break", async () => {
    const throwOnTeardown = (): void => {
      throw new Error("teardown boom");
    };
    const primary: Provider = {
      name: "primary",
      complete: () => Promise.reject(new Error("unused")),
      async *stream() {
        await Promise.resolve();
        try {
          yield "a";
          yield "b";
        } finally {
          throwOnTeardown();
        }
      },
    };
    const registry = registryOf({ primary });

    // Breaking early triggers the inner teardown; the cleanup guard swallows its
    // throw, so the break completes without surfacing the teardown error.
    const deltas: string[] = [];
    for await (const delta of registry.fallback(["primary"]).stream(PROMPT)) {
      deltas.push(delta);
      break;
    }

    expect(deltas).toEqual(["a"]);
  });
});

describe("registry.fallback — per-request retry & timeout", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("forwards the per-request retry to each attempt", async () => {
    const a = new MockProvider({ name: "a", response: down("a") });
    const b = new MockProvider({ name: "b", response: down("b") });
    const registry = registryOf({ a, b });

    const error = await registry
      .fallback(["a", "b"])
      .complete({ ...PROMPT, retry: { maxRetries: 4 } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(a.calls[0]?.retry).toEqual({ maxRetries: 4 });
    expect(b.calls[0]?.retry).toEqual({ maxRetries: 4 });
  });

  it("advances to the next entry when a provider times out", async () => {
    // A real provider whose fetch hangs until the timeout aborts it: the timeout
    // must surface as a transport ProviderError so the chain advances (the
    // body-read regression would rethrow a raw DOMException as a bug instead).
    (globalThis as any).fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const { signal } = init;
          if (!signal) {
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    );
    const primary = new OpenAIProvider({ apiKey: "sk-test" });
    const secondary = new MockProvider({ response: "secondary answer" });
    const registry = registryOf({ primary, secondary });

    const result = await registry
      .fallback(["primary", "secondary"])
      .complete({ ...PROMPT, timeoutMs: 10 });

    expect(result.text).toBe("secondary answer");
    expect(secondary.calls).toHaveLength(1);
  });
});
