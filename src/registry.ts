/**
 * Provider registry — the package's single point of access to its providers.
 *
 * You configure the registry with the providers you want (and their API keys);
 * the library constructs the built-in providers by name and hands one back via
 * {@link ProviderRegistry.select}. Consumers never import the provider classes
 * directly. It never reads env vars — keys are always passed in the config.
 */

import {
  AnthropicProvider,
  type AnthropicProviderOptions,
} from "./providers/anthropic";
import { GeminiProvider, type GeminiProviderOptions } from "./providers/gemini";
import { OpenAIProvider, type OpenAIProviderOptions } from "./providers/openai";
import { type Provider } from "./types";

/** Per-provider configuration. Include a provider's key to register it. */
export type ProviderRegistryConfig = {
  anthropic?: AnthropicProviderOptions;
  openai?: OpenAIProviderOptions;
  gemini?: GeminiProviderOptions;
};

/** The names the registry knows how to construct. */
export type ProviderName = keyof ProviderRegistryConfig;

export class ProviderRegistry {
  readonly #providers = new Map<ProviderName, Provider>();

  /**
   * Construct the providers present in `config`. A provider is registered only
   * if its entry is supplied; the rest are left out.
   */
  constructor(config: ProviderRegistryConfig) {
    if (config.anthropic) {
      this.#providers.set("anthropic", new AnthropicProvider(config.anthropic));
    }
    if (config.openai) {
      this.#providers.set("openai", new OpenAIProvider(config.openai));
    }
    if (config.gemini) {
      this.#providers.set("gemini", new GeminiProvider(config.gemini));
    }
  }

  /**
   * Return the provider registered under `name`. Throws a clear error listing
   * the configured names if that provider was not configured.
   */
  select(name: ProviderName): Provider {
    const provider = this.#providers.get(name);
    if (provider === undefined) {
      throw new Error(
        `No provider "${name}" configured. Configured: ${this.#configuredList()}`,
      );
    }
    return provider;
  }

  /** Whether a provider is configured under `name`. */
  has(name: string): boolean {
    return this.#providers.has(name as ProviderName);
  }

  /** The names of all configured providers. */
  names(): ProviderName[] {
    return [...this.#providers.keys()];
  }

  #configuredList(): string {
    const names = this.names();
    return names.length > 0 ? names.join(", ") : "(none)";
  }
}
