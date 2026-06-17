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

  it("returns undefined for an unknown model", () => {
    expect(costOfUsage(usage(100, 100), "mystery-model")).toBeUndefined();
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
