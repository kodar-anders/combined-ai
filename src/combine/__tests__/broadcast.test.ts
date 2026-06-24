import { describe, expect, it } from "@jest/globals";

import { type ProviderName } from "../../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
  type Usage,
} from "../../types";
import { broadcast } from "../broadcast";
import { type ResolvedEmbedder } from "../embedding";
import { type CombineEvent, type CombineRequest } from "../index";

type Call = { provider: string; request: CompletionRequest };

/**
 * A network-free {@link Provider} for broadcast tests: returns a fixed answer
 * (with optional usage), or throws when `fail` is set. Records each call so tests
 * can assert what was sent (no framing, model override, …).
 */
function fakeProvider(
  name: string,
  calls: Call[],
  outcome: { text?: string; usage?: Usage; fail?: boolean },
): Provider {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      calls.push({ provider: name, request });
      if (outcome.fail === true) {
        throw new Error(`${name} failed`);
      }
      return {
        text: outcome.text ?? `${name} answer`,
        model: `${name}-model`,
        usage: outcome.usage,
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *stream(): AsyncGenerator<string, void, void> {
      throw new Error("stream is not used by broadcast");
    },
  };
}

function request(overrides?: Partial<CombineRequest>): CombineRequest {
  return {
    messages: [{ role: "user", content: "Say hello." }],
    participants: ["anthropic", "openai", "google"],
    strategy: "broadcast",
    ...overrides,
  };
}

function entry(
  name: ProviderName,
  provider: Provider,
): {
  id: string;
  providerName: ProviderName;
  provider: Provider;
} {
  return { id: name, providerName: name, provider };
}

describe("broadcast", () => {
  it("returns every participant's response in participant order", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "A" })),
      entry("openai", fakeProvider("openai", calls, { text: "B" })),
      entry("google", fakeProvider("google", calls, { text: "C" })),
    ];

    const result = await broadcast(roster, request());

    expect(result.strategy).toBe("broadcast");
    expect(result.responses.map((o) => o.id)).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
    expect(result.responses.every((o) => o.status === "ok")).toBe(true);
    expect(
      result.responses.map((o) => (o.status === "ok" ? o.result.text : null)),
    ).toEqual(["A", "B", "C"]);
  });

  it("sends the raw prompt with no shaped framing", async () => {
    const calls: Call[] = [];
    const messages = [{ role: "user" as const, content: "Original prompt." }];
    const roster = [entry("anthropic", fakeProvider("anthropic", calls, {}))];

    await broadcast(
      roster,
      request({ messages, system: "Be terse.", participants: ["anthropic"] }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.messages).toEqual(messages);
    expect(calls[0]?.request.system).toBe("Be terse.");
  });

  it("records failures but still returns the successes", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "ok" })),
      entry("openai", fakeProvider("openai", calls, { fail: true })),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
    );

    expect(result.responses.map((o) => o.status)).toEqual(["ok", "failed"]);
    const failed = result.responses[1];
    expect(failed?.status === "failed" && failed.error.message).toBe(
      "openai failed",
    );
  });

  it("throws an AggregateError carrying every participant's error when all fail", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { fail: true })),
      entry("openai", fakeProvider("openai", calls, { fail: true })),
    ];

    const error = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toMatch(
      /no participant returned a response/,
    );
    expect(
      (error as AggregateError).errors.map((e: Error) => e.message),
    ).toEqual(["anthropic failed", "openai failed"]);
  });

  it("counts an empty-text response as a success", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "" })),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic"] }),
    );

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]?.status).toBe("ok");
  });

  it("emits a response event as each participant settles", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "ok" })),
      entry("openai", fakeProvider("openai", calls, { fail: true })),
    ];

    await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
      { onEvent: (event) => events.push(event) },
    );

    expect(events).toContainEqual({
      type: "response",
      id: "anthropic",
      provider: "anthropic",
      status: "ok",
    });
    expect(events).toContainEqual({
      type: "response",
      id: "openai",
      provider: "openai",
      status: "failed",
    });
  });

  it("applies each participant's model override to its call", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, {}),
        model: "claude-x",
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, {}),
        model: "gpt-x",
      },
    ];

    await broadcast(roster, request({ participants: ["anthropic", "openai"] }));

    expect(calls.find((c) => c.provider === "anthropic")?.request.model).toBe(
      "claude-x",
    );
    expect(calls.find((c) => c.provider === "openai")?.request.model).toBe(
      "gpt-x",
    );
  });

  it("aggregates token usage across participants", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, {
          usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        }),
      ),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
    );

    expect(result.usage?.total).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      totalTokens: 43,
    });
    expect(result.usage?.byParticipant.anthropic).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("accepts budget but is inert on the fan-out (no pre-empting, no budget event)", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const big: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
    };
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { usage: big })),
      entry("openai", fakeProvider("openai", calls, { usage: big })),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
      // A tiny budget can't gate a single parallel burst, so it does nothing here.
      { budget: { usd: 0.000_001 }, onEvent: (event) => events.push(event) },
    );

    // Both participants still answered, and no budget event is emitted (the
    // fan-out strategies have no phase to gate, so the budget stays inert).
    expect(result.responses).toHaveLength(2);
    expect(events.some((e) => e.type === "budget")).toBe(false);
  });
});

// 2-D vectors so the cosine relationships are obvious: "A"/"B" identical, "C"
// orthogonal to both.
const EMBED_VECTORS: Record<string, number[]> = {
  A: [1, 0],
  B: [1, 0],
  C: [0, 1],
};

function fakeEmbedder(opts?: {
  usage?: Usage;
  fail?: boolean;
}): ResolvedEmbedder {
  const provider: Provider & { embed: NonNullable<Provider["embed"]> } = {
    name: "emb",
    complete: () => {
      throw new Error("complete not used in this test");
    },
    stream: () => {
      throw new Error("stream not used in this test");
    },
    embed: (req: EmbeddingRequest): Promise<EmbeddingResult> => {
      if (opts?.fail === true) {
        return Promise.reject(new Error("embed failed"));
      }
      return Promise.resolve({
        embeddings: req.input.map((text) => EMBED_VECTORS[text] ?? [0, 0]),
        model: "embed-model",
        usage: opts?.usage,
      });
    },
  };
  return { name: "emb", provider };
}

describe("broadcast semantic comparison", () => {
  it("attaches agreement, outlier, and clusters when an embedder is given", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "A" })),
      entry("openai", fakeProvider("openai", calls, { text: "B" })),
      entry("google", fakeProvider("google", calls, { text: "C" })),
    ];

    const result = await broadcast(
      roster,
      request(),
      undefined,
      fakeEmbedder({
        usage: { inputTokens: 9, outputTokens: 0, totalTokens: 9 },
      }),
    );

    expect(result.semantic?.agreement).toBeCloseTo(1 / 3);
    expect(result.semantic?.outlier).toBe("google");
    expect(result.semantic?.clusters).toEqual([
      ["anthropic", "openai"],
      ["google"],
    ]);
    // The embedding call's usage is folded into the ledger under a distinct
    // `embedding:<provider>` id (not a participant id).
    expect(result.usage?.byParticipant["embedding:emb"]).toEqual({
      inputTokens: 9,
      outputTokens: 0,
      totalTokens: 9,
    });
  });

  it("omits the comparison when only one non-empty answer is returned", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "A" })),
      entry("openai", fakeProvider("openai", calls, { text: "" })),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
      undefined,
      fakeEmbedder(),
    );

    expect(result.semantic).toBeUndefined();
  });

  it("does not fail the broadcast when the embedding pass throws", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "A" })),
      entry("openai", fakeProvider("openai", calls, { text: "B" })),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
      undefined,
      fakeEmbedder({ fail: true }),
    );

    expect(result.responses).toHaveLength(2);
    expect(result.semantic).toBeUndefined();
  });

  it("produces no semantic field when no embedder is configured", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { text: "A" })),
      entry("openai", fakeProvider("openai", calls, { text: "B" })),
    ];

    const result = await broadcast(
      roster,
      request({ participants: ["anthropic", "openai"] }),
    );

    expect(result.semantic).toBeUndefined();
  });
});
