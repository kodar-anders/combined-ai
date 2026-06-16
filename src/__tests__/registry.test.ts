import { describe, expect, it } from "@jest/globals";

import { type StrategyName } from "../combine";
import { ProviderRegistry } from "../registry";

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
      gemini: { apiKey: "g" },
    });

    expect(registry.select("anthropic").name).toBe("anthropic");
    expect(registry.select("openai").name).toBe("openai");
    expect(registry.select("gemini").name).toBe("gemini");
    expect(registry.names()).toEqual(["anthropic", "openai", "gemini"]);
  });

  it("only registers providers present in the config", () => {
    const registry = new ProviderRegistry({ openai: { apiKey: "o" } });

    expect(registry.has("openai")).toBe(true);
    expect(registry.has("anthropic")).toBe(false);
    expect(registry.names()).toEqual(["openai"]);
  });

  it("returns names in a fixed order regardless of config key order", () => {
    const registry = new ProviderRegistry({
      gemini: { apiKey: "g" },
      openai: { apiKey: "o" },
      anthropic: { apiKey: "a" },
    });

    expect(registry.names()).toEqual(["anthropic", "openai", "gemini"]);
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
});
