import { describe, expect, it } from "@jest/globals";

import { type Usage } from "../../types";
import { combineCost } from "../cost";
import {
  type CallUsage,
  type CombineResult,
  type CombineUsage,
} from "../index";

const usage = (
  inputTokens: number,
  outputTokens: number,
  totalTokens?: number,
): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: totalTokens ?? inputTokens + outputTokens,
});

/**
 * A minimal {@link CombineResult} carrying `calls` — the only field `combineCost`
 * reads. `total`/`byParticipant` are filled trivially (combineCost ignores them).
 */
function resultWith(calls: CallUsage[]): CombineResult {
  const combineUsage: CombineUsage = {
    total: usage(0, 0),
    byParticipant: {},
    calls,
  };
  return { strategy: "broadcast", responses: [], usage: combineUsage };
}

describe("combineCost", () => {
  it("prices each call individually and sums, with a per-participant breakdown", () => {
    // gpt-4.1: $2/$8 per MTok. claude-opus-4-8: $5/$25 per MTok.
    const cost = combineCost(
      resultWith([
        { id: "openai", model: "gpt-4.1", usage: usage(1_000_000, 500_000) }, // $2 + $4 = $6
        { id: "anthropic", model: "claude-opus-4-8", usage: usage(0, 0) }, // inputTokens<=0 → unpriceable
        {
          id: "openai",
          model: "gpt-4.1",
          usage: usage(500_000, 0), // $1
        },
      ]),
    );
    expect(cost).toEqual({
      totalCost: 7,
      byParticipant: { openai: 7 },
    });
  });

  it("prices each call at its own tier (never the summed tokens)", () => {
    // gemini-2.5-pro: base $1.25/$10 (≤200k), high tier $2.50/$15 (>200k).
    // Two 150k-input calls: each stays at base ($0.1875), total $0.375. Summed
    // (300k > 200k) they would wrongly bill the high tier — this pins per-call.
    const cost = combineCost(
      resultWith([
        { id: "google", model: "gemini-2.5-pro", usage: usage(150_000, 0) },
        { id: "google", model: "gemini-2.5-pro", usage: usage(150_000, 0) },
      ]),
    );
    expect(cost?.totalCost).toBeCloseTo(0.375, 10);
    // byParticipant accumulates priced dollars per id (not summed tokens), so it
    // also stays at the base tier.
    expect(cost?.byParticipant.google).toBeCloseTo(0.375, 10);
  });

  it("prices cached calls cheaper via each call's usage", () => {
    // claude-opus-4-8: input $5, cached read $0.5 per MTok. A fully-cached 1M call
    // costs $0.5 vs $5 uncached — the discount flows through the per-call ledger.
    const cached: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    };
    const cost = combineCost(
      resultWith([
        { id: "anthropic", model: "claude-opus-4-8", usage: cached },
      ]),
    );
    expect(cost?.totalCost).toBeCloseTo(0.5, 10);
  });

  it("skips calls whose model is unknown to the registry (total understates)", () => {
    const cost = combineCost(
      resultWith([
        { id: "openai", model: "gpt-4.1", usage: usage(1_000_000, 0) }, // $2
        {
          id: "local",
          model: "some-unlisted-model",
          usage: usage(1_000_000, 0),
        },
      ]),
    );
    // Only the priceable call is counted; the unknown model is omitted entirely.
    expect(cost).toEqual({ totalCost: 2, byParticipant: { openai: 2 } });
  });

  it("prices custom models via options.models", () => {
    const cost = combineCost(
      resultWith([
        { id: "local", model: "my-model", usage: usage(1_000_000, 1_000_000) },
      ]),
      { models: { "my-model": { inputPerMTok: 1, outputPerMTok: 2 } } },
    );
    expect(cost).toEqual({ totalCost: 3, byParticipant: { local: 3 } });
  });

  it("returns undefined when no call is priceable", () => {
    expect(
      combineCost(
        resultWith([
          { id: "local", model: "unknown-a", usage: usage(100, 100) },
          { id: "local", model: "unknown-b", usage: usage(100, 100) },
        ]),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for no usage or an empty ledger", () => {
    // A result with no usage block at all.
    expect(
      combineCost({ strategy: "broadcast", responses: [] }),
    ).toBeUndefined();
    // A usage block whose ledger is empty.
    expect(combineCost(resultWith([]))).toBeUndefined();
  });
});
