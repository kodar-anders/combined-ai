import { describe, expect, it } from "@jest/globals";

import { synthesizeText } from "../synthesize";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type Usage,
} from "../types";

/** synthesizeText always builds string content, so tests can read it back as text. */
function firstText(request: CompletionRequest | undefined): string {
  const content = request?.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

/** A network-free {@link Provider} that records every call and returns a fixed result. */
function fakeProvider(
  calls: CompletionRequest[],
  result?: Partial<CompletionResult>,
  error?: Error,
): Provider {
  return {
    name: "fake",
    // eslint-disable-next-line @typescript-eslint/require-await
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      calls.push(request);
      if (error !== undefined) {
        throw error;
      }
      return { text: "merged answer", model: "fake-model", ...result };
    },
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *stream(): AsyncGenerator<string, void, void> {
      throw new Error("stream is not used by synthesizeText");
    },
  };
}

describe("synthesizeText", () => {
  it("makes exactly one completion call with the prompt/candidates shape", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "What is the capital of France?", [
      "Paris",
      "The city of Paris",
    ]);

    expect(calls).toHaveLength(1);
    const body = calls[0]?.messages[0]?.content;
    expect(body).toBe(
      "## Prompt\nWhat is the capital of France?\n\n" +
        "## Candidate answers\n### Answer A\nParis\n\n### Answer B\nThe city of Paris",
    );
  });

  it("includes the framing test-coupling marker in the system prompt", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["a", "b"]);

    expect(calls[0]?.system).toContain("Merge them into one coherent");
  });

  it("letters candidates as Answer A/B/C in input order", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["first", "second", "third"]);

    const body = firstText(calls[0]);
    expect(body.indexOf("### Answer A")).toBeLessThan(
      body.indexOf("### Answer B"),
    );
    expect(body.indexOf("### Answer B")).toBeLessThan(
      body.indexOf("### Answer C"),
    );
    expect(body).toContain("### Answer A\nfirst");
    expect(body).toContain("### Answer B\nsecond");
    expect(body).toContain("### Answer C\nthird");
  });

  it("drops whitespace-only candidates before rendering/counting", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["real one", " \t\n", "real two"]);

    const body = firstText(calls[0]);
    expect(body).toContain("### Answer A\nreal one");
    expect(body).toContain("### Answer B\nreal two");
    expect(body).not.toContain("Answer C");
  });

  it("throws when given 0 candidates", async () => {
    const provider = fakeProvider([]);
    await expect(synthesizeText(provider, "prompt", [])).rejects.toThrow(
      "synthesizeText requires at least 2 non-blank candidates, got 0",
    );
  });

  it("throws when given 1 candidate", async () => {
    const provider = fakeProvider([]);
    await expect(
      synthesizeText(provider, "prompt", ["only one"]),
    ).rejects.toThrow(
      "synthesizeText requires at least 2 non-blank candidates, got 1",
    );
  });

  it("throws when 3 raw candidates leave only 1 non-blank after filtering", async () => {
    const provider = fakeProvider([]);
    await expect(
      synthesizeText(provider, "prompt", ["real", "  ", ""]),
    ).rejects.toThrow(
      "synthesizeText requires at least 2 non-blank candidates, got 1",
    );
  });

  it("succeeds when 3 raw candidates leave exactly 2 non-blank after filtering", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    const result = await synthesizeText(provider, "prompt", [
      "real one",
      "  ",
      "real two",
    ]);

    expect(calls).toHaveLength(1);
    expect(result.text).toBe("merged answer");
  });

  it("throws a plain Error, not a ProviderError", async () => {
    const provider = fakeProvider([]);
    let caught: unknown;
    try {
      await synthesizeText(provider, "prompt", []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { kind?: unknown }).kind).toBeUndefined();
  });

  it("propagates a rejected provider.complete() call unwrapped", async () => {
    const boom = new Error("provider exploded");
    const provider = fakeProvider([], undefined, boom);

    await expect(synthesizeText(provider, "prompt", ["a", "b"])).rejects.toBe(
      boom,
    );
  });

  it("forwards model to the built CompletionRequest", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["a", "b"], {
      model: "gpt-x",
    });

    expect(calls[0]?.model).toBe("gpt-x");
  });

  it("forwards maxTokens to the built CompletionRequest", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["a", "b"], {
      maxTokens: 256,
    });

    expect(calls[0]?.maxTokens).toBe(256);
  });

  it("forwards temperature to the built CompletionRequest", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["a", "b"], {
      temperature: 0.3,
    });

    expect(calls[0]?.temperature).toBe(0.3);
  });

  it("forwards signal to the built CompletionRequest", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);
    const controller = new AbortController();

    await synthesizeText(provider, "prompt", ["a", "b"], {
      signal: controller.signal,
    });

    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("forwards retry and timeoutMs to the built CompletionRequest", async () => {
    const calls: CompletionRequest[] = [];
    const provider = fakeProvider(calls);

    await synthesizeText(provider, "prompt", ["a", "b"], {
      retry: { maxRetries: 0 },
      timeoutMs: 5000,
    });

    expect(calls[0]?.retry).toEqual({ maxRetries: 0 });
    expect(calls[0]?.timeoutMs).toBe(5000);
  });

  it("returns the raw CompletionResult unmodified, incl. usage/finishReason", async () => {
    const calls: CompletionRequest[] = [];
    const usage: Usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const provider = fakeProvider(calls, {
      finishReason: "stop",
      rawFinishReason: "end_turn",
      usage,
    });

    const result = await synthesizeText(provider, "prompt", ["a", "b"]);

    expect(result).toEqual({
      text: "merged answer",
      model: "fake-model",
      finishReason: "stop",
      rawFinishReason: "end_turn",
      usage,
    });
  });
});
