import { describe, expect, it } from "@jest/globals";

import { costOf, costOfUsage } from "../cost";
import { type CompletionResult, type Usage } from "../types";

const usage = (
  inputTokens: number,
  outputTokens: number,
  totalTokens?: number,
): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: totalTokens ?? inputTokens + outputTokens,
});

describe("costOfUsage", () => {
  it("prices input and output per MTok against a known model", () => {
    // gpt-4.1: $2 / $8 per MTok. 1M in + 0.5M out → $2 + $4 = $6.
    expect(costOfUsage(usage(1_000_000, 500_000), "gpt-4.1")).toEqual({
      model: "gpt-4.1",
      inputCost: 2,
      outputCost: 4,
      totalCost: 6,
    });
  });

  it("reports the resolved canonical id for a dated snapshot", () => {
    const breakdown = costOfUsage(usage(1_000_000, 0), "gpt-4.1-2025-04-14");
    expect(breakdown?.model).toBe("gpt-4.1");
    expect(breakdown?.inputCost).toBe(2);
  });

  it("bills Gemini thinking tokens (the totalTokens residual) at the output rate", () => {
    // gemini-2.5-pro ≤200k tier: $1.25 / $10 per MTok. totalTokens exceeds
    // input+output by 1M thinking tokens, which must be billed at the output rate.
    const u = usage(100_000, 0, 1_100_000); // 1M thinking residual, ≤200k prompt
    const breakdown = costOfUsage(u, "gemini-2.5-pro");
    expect(breakdown).toEqual({
      model: "gemini-2.5-pro",
      inputCost: 0.125, // 100k * $1.25/MTok
      outputCost: 10, // 1M thinking * $10/MTok
      totalCost: 10.125,
    });
  });

  it("applies the gemini-2.5-pro high tier above 200k prompt tokens", () => {
    // >200k prompt → both input and output bill at $2.50 / $15 per MTok.
    const breakdown = costOfUsage(usage(300_000, 50_000), "gemini-2.5-pro");
    expect(breakdown).toEqual({
      model: "gemini-2.5-pro",
      inputCost: 0.75, // 300k * $2.50/MTok
      outputCost: 0.75, // 50k * $15/MTok
      totalCost: 1.5,
    });
  });

  it("uses the low tier at exactly 200k prompt tokens (threshold is exclusive)", () => {
    const breakdown = costOfUsage(usage(200_000, 0), "gemini-2.5-pro");
    expect(breakdown?.inputCost).toBe(0.25); // 200k * $1.25/MTok (low tier)
  });

  it("returns undefined for empty/all-zero usage (input <= 0)", () => {
    // A gateway returning `usage: {}` yields {0,0,0}; a confident $0 would read as
    // "free", so decline instead.
    expect(
      costOfUsage(
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        "gpt-4.1",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for malformed usage with no input tokens", () => {
    // total present but prompt_tokens dropped → would mis-bill input at the
    // output rate via the residual; decline instead.
    expect(
      costOfUsage(
        { inputTokens: 0, outputTokens: 500, totalTokens: 1500 },
        "gpt-4.1",
      ),
    ).toBeUndefined();
  });

  it("does not over-bill when totalTokens equals input+output (no residual)", () => {
    // Anthropic/OpenAI: total == input + output, so residual is 0.
    const breakdown = costOfUsage(usage(1_000_000, 1_000_000), "gpt-4.1");
    expect(breakdown?.outputCost).toBe(8); // 1M * $8/MTok, no thinking add-on
  });

  it("treats a totalTokens below input+output as zero residual (no negative)", () => {
    const breakdown = costOfUsage(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 0 },
      "gpt-4.1",
    );
    expect(breakdown?.outputCost).toBe(8);
  });

  it("prices cache reads at the discounted rate, the remainder at full rate", () => {
    // claude-opus-4-8: input $5, cached read $0.5 per MTok. 1M prompt of which
    // 800k were cache reads → 200k * $5 + 800k * $0.5 = $1.0 + $0.4 = $1.4.
    const breakdown = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 800_000,
        totalTokens: 1_000_000,
      },
      "claude-opus-4-8",
    );
    expect(breakdown?.inputCost).toBeCloseTo(1.4, 10);
  });

  it("a cached call prices below the same call uncached", () => {
    const cached = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        totalTokens: 1_000_000,
      },
      "claude-opus-4-8",
    );
    const uncached = costOfUsage(usage(1_000_000, 0), "claude-opus-4-8");
    expect(cached!.inputCost).toBeLessThan(uncached!.inputCost);
    expect(cached?.inputCost).toBeCloseTo(0.5, 10); // 1M * $0.5/MTok
  });

  it("prices Anthropic cache writes at the write premium", () => {
    // claude-opus-4-8: input $5, cache write $6.25 per MTok. A first cached call:
    // 200k uncached + 800k written → 200k * $5 + 800k * $6.25 = $1.0 + $5.0 = $6.0.
    const breakdown = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationInputTokens: 800_000,
        totalTokens: 1_000_000,
      },
      "claude-opus-4-8",
    );
    expect(breakdown?.inputCost).toBeCloseTo(6, 10);
  });

  it("falls back to the full input rate when a model lists no cached rate", () => {
    // gpt-4.1 has no cachedInputPerMTok, so cache reads bill at the $2 input rate:
    // the cost matches the same all-uncached call (no fabricated discount).
    const cached = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        totalTokens: 1_000_000,
      },
      "gpt-4.1",
    );
    expect(cached?.inputCost).toBe(2);
  });

  it("prices Gemini cache reads at the model's cached rate", () => {
    // gemini-2.5-flash-lite: input $0.1, cached $0.01 per MTok. 1M prompt, 800k
    // cached → 200k*$0.1 + 800k*$0.01 = $0.02 + $0.008 = $0.028.
    const breakdown = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 800_000,
        totalTokens: 1_000_000,
      },
      "gemini-2.5-flash-lite",
    );
    expect(breakdown?.inputCost).toBeCloseTo(0.028, 10);
  });

  it("uses gemini-2.5-pro's high-tier cached rate above 200k prompt tokens", () => {
    // >200k → high tier: input $2.50, cached $0.25 per MTok. 300k prompt, 100k
    // cached → 200k*$2.50 + 100k*$0.25 = $0.5 + $0.025 = $0.525.
    const breakdown = costOfUsage(
      {
        inputTokens: 300_000,
        outputTokens: 0,
        cachedInputTokens: 100_000,
        totalTokens: 300_000,
      },
      "gemini-2.5-pro",
    );
    expect(breakdown?.inputCost).toBeCloseTo(0.525, 10);
  });

  it("uses gemini-2.5-pro's base cached rate at/below 200k prompt tokens", () => {
    // ≤200k → base: input $1.25, cached $0.125 per MTok. 200k prompt, 100k cached
    // → 100k*$1.25 + 100k*$0.125 = $0.125 + $0.0125 = $0.1375.
    const breakdown = costOfUsage(
      {
        inputTokens: 200_000,
        outputTokens: 0,
        cachedInputTokens: 100_000,
        totalTokens: 200_000,
      },
      "gemini-2.5-pro",
    );
    expect(breakdown?.inputCost).toBeCloseTo(0.1375, 10);
  });

  it("falls back to the base cached rate above the threshold when highTier omits it", () => {
    // A tiered model whose highTier omits cachedInputPerMTok: per the documented
    // contract, cache reads above the threshold use the BASE cached rate ($1/MTok),
    // not the high-tier input rate ($20/MTok) — guards a ~20x over-bill regression.
    const models = {
      tiered: {
        inputPerMTok: 10,
        outputPerMTok: 0,
        cachedInputPerMTok: 1,
        highTier: { aboveInputTokens: 100, inputPerMTok: 20, outputPerMTok: 0 },
      },
    };
    const breakdown = costOfUsage(
      {
        inputTokens: 200, // >100 → high tier
        outputTokens: 0,
        cachedInputTokens: 200, // all cache reads
        totalTokens: 200,
      },
      "tiered",
      { models },
    );
    expect(breakdown?.inputCost).toBeCloseTo((200 * 1) / 1_000_000, 12);
  });

  it("keeps the Gemini thinking residual at zero for a cached Anthropic call", () => {
    // Anthropic superset: input_tokens(100) + read(800) + write(100) folded into
    // inputTokens=1000, totalTokens=inputTokens+output → residual is 0 (no thinking
    // add-on). claude-haiku-4-5: input $1, read $0.1, write $1.25 per MTok.
    const breakdown = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 800_000,
        cacheCreationInputTokens: 100_000,
        totalTokens: 1_000_000,
      },
      "claude-haiku-4-5",
    );
    // 100k * $1 + 800k * $0.1 + 100k * $1.25 = $0.1 + $0.08 + $0.125 = $0.305.
    expect(breakdown).toEqual({
      model: "claude-haiku-4-5",
      inputCost: expect.closeTo(0.305, 10),
      outputCost: 0,
      totalCost: expect.closeTo(0.305, 10),
    });
  });

  it("never produces a negative input cost when a cache count exceeds the remainder", () => {
    // A skewed usage where cached > input (e.g. a misbehaving gateway). The uncached
    // remainder is clamped to 0, so the full-rate portion can't go negative.
    const breakdown = costOfUsage(
      {
        inputTokens: 100,
        outputTokens: 0,
        cachedInputTokens: 1000,
        totalTokens: 100,
      },
      "claude-opus-4-8",
    );
    expect(breakdown!.inputCost).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined for an unknown model", () => {
    expect(costOfUsage(usage(100, 100), "mystery-model")).toBeUndefined();
  });

  it("prices an embedding model on input only (output rate is 0)", () => {
    // text-embedding-3-small: $0.02/MTok input, $0/MTok output. An embedding
    // usage carries outputTokens:0 and totalTokens===inputTokens, so the whole
    // cost is the input.
    expect(costOfUsage(usage(1_000_000, 0), "text-embedding-3-small")).toEqual({
      model: "text-embedding-3-small",
      inputCost: 0.02,
      outputCost: 0,
      totalCost: 0.02,
    });
  });

  it("prices via an override table", () => {
    const breakdown = costOfUsage(usage(1_000_000, 1_000_000), "local", {
      models: { local: { inputPerMTok: 10, outputPerMTok: 20 } },
    });
    expect(breakdown).toEqual({
      model: "local",
      inputCost: 10,
      outputCost: 20,
      totalCost: 30,
    });
  });
});

describe("costOf", () => {
  it("prices a CompletionResult from its usage and model", () => {
    const result: CompletionResult = {
      text: "hi",
      model: "claude-opus-4-8",
      usage: usage(1_000_000, 1_000_000),
    };
    // claude-opus-4-8: $5 / $25 per MTok.
    expect(costOf(result)).toEqual({
      model: "claude-opus-4-8",
      inputCost: 5,
      outputCost: 25,
      totalCost: 30,
    });
  });

  it("returns undefined when the result has no usage", () => {
    const result: CompletionResult = { text: "hi", model: "claude-opus-4-8" };
    expect(costOf(result)).toBeUndefined();
  });

  it("returns undefined when the result's model is unknown", () => {
    const result: CompletionResult = {
      text: "hi",
      model: "some-gateway/model",
      usage: usage(100, 100),
    };
    expect(costOf(result)).toBeUndefined();
  });
});
