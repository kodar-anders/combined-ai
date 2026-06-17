import { describe, expect, it } from "@jest/globals";

import { findModel, listModels, PRICING_VERIFIED_ON } from "../models";

describe("findModel", () => {
  it("resolves an exact built-in key", () => {
    expect(findModel("claude-opus-4-8")).toEqual({
      id: "claude-opus-4-8",
      pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    });
  });

  it("resolves a dated OpenAI snapshot to its base id by longest-prefix", () => {
    const info = findModel("gpt-4.1-2025-04-14");
    expect(info?.id).toBe("gpt-4.1");
    expect(info?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8 });
  });

  it("keeps gpt-4.1-mini distinct from gpt-4.1 (longest anchored prefix wins)", () => {
    // The collision the delimiter anchor exists to handle: a bare startsWith
    // would let "gpt-4.1" swallow the mini id.
    expect(findModel("gpt-4.1-mini")?.id).toBe("gpt-4.1-mini");
    expect(findModel("gpt-4.1-mini-2025-04-14")?.id).toBe("gpt-4.1-mini");
    expect(findModel("gpt-4.1-mini")?.pricing).toEqual({
      inputPerMTok: 0.4,
      outputPerMTok: 1.6,
    });
  });

  it("resolves an Anthropic dated alias by anchored prefix", () => {
    expect(findModel("claude-opus-4-8-20250101")?.id).toBe("claude-opus-4-8");
  });

  it("does not let one model family prefix-match another (anchor required)", () => {
    // "claude-opus-4-8" must not match a hypothetical sibling like
    // "claude-opus-4-1..." — the "-" anchor prevents bare-substring conflation.
    expect(findModel("claude-opus-4-1-20250101")).toBeUndefined();
  });

  it("resolves a Gemini modelVersion exactly", () => {
    const pro = findModel("gemini-2.5-pro")?.pricing;
    expect(pro?.inputPerMTok).toBe(1.25);
    expect(pro?.outputPerMTok).toBe(10);
    expect(pro?.highTier).toEqual({
      aboveInputTokens: 200_000,
      inputPerMTok: 2.5,
      outputPerMTok: 15,
    });
    expect(findModel("gemini-2.5-flash")?.id).toBe("gemini-2.5-flash");
  });

  it("returns undefined for an unknown model", () => {
    expect(findModel("some-unconfigured-model")).toBeUndefined();
  });

  it("does not false-match a namespaced gateway id", () => {
    // OpenRouter-style ids don't start with a table key, so they miss.
    expect(findModel("openai/gpt-4.1")).toBeUndefined();
  });

  it("does not mis-price a differently-priced sibling model (word suffix → miss)", () => {
    // `gpt-4o-audio-preview` is a real, differently-priced model that shares the
    // `gpt-4o-` prefix but is NOT a snapshot of `gpt-4o`. The digit-anchored rule
    // refuses to inherit the base price — better undefined than a confident wrong
    // number — even when a dated suffix follows the word segment.
    expect(findModel("gpt-4o-audio-preview")).toBeUndefined();
    expect(findModel("gpt-4o-audio-preview-2024-12-17")).toBeUndefined();
    expect(findModel("gemini-2.5-pro-vision")).toBeUndefined();
  });

  it("prices the added common models", () => {
    expect(findModel("claude-sonnet-4-6")?.pricing).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
    expect(findModel("gpt-4o-mini")?.pricing).toEqual({
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
    });
    expect(findModel("gemini-2.5-flash-lite")?.pricing).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.4,
    });
  });

  it("returns a copy whose mutation does not corrupt the registry", () => {
    const info = findModel("gemini-2.5-pro");
    expect(info).toBeDefined();
    if (info) {
      info.pricing.inputPerMTok = -1;
      if (info.pricing.highTier) {
        info.pricing.highTier.inputPerMTok = -1;
      }
    }
    expect(findModel("gemini-2.5-pro")?.pricing.inputPerMTok).toBe(1.25);
    expect(findModel("gemini-2.5-pro")?.pricing.highTier?.inputPerMTok).toBe(
      2.5,
    );
  });

  it("prices an override model not in the built-in table", () => {
    const info = findModel("my-local-model", {
      models: { "my-local-model": { inputPerMTok: 0, outputPerMTok: 0 } },
    });
    expect(info).toEqual({
      id: "my-local-model",
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    });
  });

  it("lets an override win over a built-in key", () => {
    const info = findModel("gpt-4.1", {
      models: { "gpt-4.1": { inputPerMTok: 99, outputPerMTok: 99 } },
    });
    expect(info?.pricing).toEqual({ inputPerMTok: 99, outputPerMTok: 99 });
  });
});

describe("listModels", () => {
  it("lists every built-in with positive prices and unique ids", () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of models) {
      expect(m.pricing.inputPerMTok).toBeGreaterThan(0);
      expect(m.pricing.outputPerMTok).toBeGreaterThan(0);
    }
  });

  it("returns a copy that does not mutate the registry", () => {
    const first = listModels();
    const target = first.find((m) => m.id === "gpt-4.1");
    expect(target).toBeDefined();
    if (target) {
      target.pricing.inputPerMTok = -1;
    }
    expect(findModel("gpt-4.1")?.pricing.inputPerMTok).toBe(2);
  });
});

describe("PRICING_VERIFIED_ON", () => {
  it("is an ISO YYYY-MM-DD date string", () => {
    expect(PRICING_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
