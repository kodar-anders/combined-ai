import { describe, expect, it } from "@jest/globals";

import { ProviderRegistry } from "../registry";

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
