/**
 * Provider registry — the package's single point of access to its providers.
 *
 * You configure the registry with the providers you want (and their API keys);
 * the library constructs the built-in providers by name and hands one back via
 * {@link ProviderRegistry.select}. Consumers never import the provider classes
 * directly. It never reads env vars — keys are always passed in the config.
 */

import {
  type CombineOptions,
  type CombineRequest,
  type CombineResult,
  STRATEGY_NAMES,
} from "./combine";
import { consensus } from "./combine/consensus";
import { pipeline } from "./combine/pipeline";
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

  /**
   * Combine several configured providers to cooperate on one prompt using a
   * cooperation strategy — `consensus` (draft → critique → synthesize) or
   * `pipeline` (sequential refinement). Participants are picked by name and
   * validated like {@link ProviderRegistry.select}. Strategy-specific options
   * (`synthesizer`, `minParticipants`, `attribution`) are validated and applied
   * only by the strategy that uses them.
   */
  async combine(
    request: CombineRequest,
    options?: CombineOptions,
  ): Promise<CombineResult> {
    const [firstParticipant] = request.participants;
    if (firstParticipant === undefined) {
      throw new Error("combine requires at least one participant");
    }
    if (new Set(request.participants).size !== request.participants.length) {
      throw new Error(
        `combine participants must be unique: ${request.participants.join(", ")}`,
      );
    }
    if (request.messages.length === 0) {
      throw new Error("combine requires at least one message");
    }
    const knownStrategies: readonly string[] = STRATEGY_NAMES;
    if (
      request.strategy !== undefined &&
      !knownStrategies.includes(request.strategy)
    ) {
      throw new Error(
        `Unknown combine strategy "${request.strategy}". Known: ${STRATEGY_NAMES.join(", ")}`,
      );
    }

    const roster = request.participants.map((name) => ({
      name,
      provider: this.select(name),
    }));

    const strategy = request.strategy ?? "consensus";
    switch (strategy) {
      // `synthesizer`/`minParticipants` are consensus-only, so they're validated
      // here (not in the shared preamble) — pipeline ignores them entirely.
      case "consensus": {
        this.#validateConsensusOptions(request);
        const synthesizer = request.synthesizer ?? firstParticipant;
        return consensus(roster, synthesizer, request, options?.onEvent);
      }
      case "pipeline":
        return pipeline(roster, request, options?.onEvent);
      default: {
        const unreachable: never = strategy;
        throw new Error(`Unhandled combine strategy "${String(unreachable)}"`);
      }
    }
  }

  /** Validate the consensus-only request options (`minParticipants`, `synthesizer`). */
  #validateConsensusOptions(request: CombineRequest): void {
    const { minParticipants } = request;
    if (minParticipants !== undefined) {
      if (!Number.isInteger(minParticipants) || minParticipants < 1) {
        throw new Error("combine minParticipants must be a positive integer");
      }
      if (minParticipants > request.participants.length) {
        throw new Error(
          `combine minParticipants (${String(minParticipants)}) cannot exceed the number of participants (${String(request.participants.length)})`,
        );
      }
    }
    if (
      request.synthesizer !== undefined &&
      !request.participants.includes(request.synthesizer)
    ) {
      throw new Error(
        `Synthesizer "${request.synthesizer}" must be one of the participants: ${request.participants.join(", ")}`,
      );
    }
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
