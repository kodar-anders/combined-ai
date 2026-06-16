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
import { ensemble } from "./combine/ensemble";
import { pipeline } from "./combine/pipeline";
import {
  AnthropicProvider,
  type AnthropicProviderOptions,
} from "./providers/anthropic";
import { GeminiProvider, type GeminiProviderOptions } from "./providers/gemini";
import { OpenAIProvider, type OpenAIProviderOptions } from "./providers/openai";
import { type RetryOptions } from "./transport";
import { type Provider } from "./types";

/**
 * An OpenAI Chat Completions–compatible endpoint registered under a custom name.
 * The library reuses its OpenAI provider against your `baseUrl`, so any service
 * that speaks the Chat Completions wire format works — OpenRouter, Together,
 * Groq, Ollama, a local server, etc.
 */
export type OpenAICompatibleConfig = {
  kind: "openai-compatible";
  apiKey: string;
  /**
   * Base URL of the endpoint, **excluding** the `/v1/chat/completions` path the
   * provider appends (e.g. `https://api.groq.com/openai`, `http://localhost:11434`).
   */
  baseUrl: string;
  /**
   * The model id to send. Required — unlike the built-ins there is no sensible
   * default for a third-party endpoint. `request.model` (or combine's `model`)
   * still overrides it per call.
   */
  model: string;
  /** Extra headers merged into every request (e.g. OpenRouter's `HTTP-Referer`/`X-Title`). */
  headers?: Record<string, string>;
  /** Bounded retry/backoff on 429/503/529. Defaults applied when omitted. */
  retry?: RetryOptions;
};

/**
 * A provider you implement yourself (anything satisfying {@link Provider}),
 * registered under a custom name. The escape hatch for an API the library
 * doesn't speak natively, or for wrapping a built-in with instrumentation.
 */
export type CustomProviderInstance = {
  kind: "provider";
  provider: Provider;
};

/** How a custom (non-built-in) provider is registered. */
export type CustomProviderConfig =
  | OpenAICompatibleConfig
  | CustomProviderInstance;

/** The names the library constructs as built-in providers (the single source of truth). */
const BUILT_IN_NAMES = ["anthropic", "openai", "gemini"] as const;

/** The provider names the library constructs from its own config. */
export type BuiltInProviderName = (typeof BUILT_IN_NAMES)[number];

/** Per-provider configuration. Include a provider's key to register it. */
export type ProviderRegistryConfig = {
  anthropic?: AnthropicProviderOptions;
  openai?: OpenAIProviderOptions;
  gemini?: GeminiProviderOptions;
  /**
   * Extra providers registered under names you choose — an OpenAI-compatible
   * gateway/local endpoint or a {@link Provider} you bring yourself. Each name
   * must not collide with a built-in.
   */
  custom?: Record<string, CustomProviderConfig>;
};

/**
 * A configured provider's name: the three built-ins, or any custom name you
 * registered. The `string & Record<never, never>` intersection keeps editor
 * autocomplete for the built-in literals while still accepting an arbitrary
 * custom string.
 */
export type ProviderName =
  | BuiltInProviderName
  | (string & Record<never, never>);

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
    if (config.custom) {
      const builtInNames: readonly string[] = BUILT_IN_NAMES;
      for (const [name, custom] of Object.entries(config.custom)) {
        if (builtInNames.includes(name)) {
          throw new Error(
            `Custom provider name "${name}" collides with a built-in; choose a different name.`,
          );
        }
        this.#providers.set(name, constructCustom(name, custom));
      }
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
   * cooperation strategy — `consensus` (draft → critique → synthesize),
   * `pipeline` (sequential refinement), or `ensemble` (each participant answers
   * under a shared JSON Schema, then the typed objects are merged field-wise with
   * an agreement score; requires `responseFormat`). Participants are picked by
   * name and validated like {@link ProviderRegistry.select}. Strategy-specific
   * options (`synthesizer`, `minParticipants`, `attribution`, `responseFormat`)
   * are validated and applied only by the strategy that uses them.
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
    // No combine strategy does tool calling (a multi-model tool loop has no
    // coherent shared state), and `completionFor` doesn't forward these — so
    // reject them loudly instead of silently ignoring a tools-bearing request.
    if (request.tools !== undefined || request.toolChoice !== undefined) {
      throw new Error(
        "combine does not support tool calling (tools/toolChoice); use registry.select() for a single-provider tool loop.",
      );
    }
    // `responseFormat` only means something for the ensemble strategy (where every
    // participant answers under the schema). For the prose strategies it would be
    // silently ignored, so reject it loudly instead.
    if (strategy !== "ensemble" && request.responseFormat !== undefined) {
      throw new Error(
        `responseFormat is only supported by the "ensemble" strategy, not "${strategy}".`,
      );
    }
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
      case "ensemble": {
        if (request.responseFormat === undefined) {
          throw new Error(
            'The "ensemble" strategy requires a responseFormat (the JSON Schema every participant answers under).',
          );
        }
        // The field-wise merge needs named fields, so the schema's root must be an
        // object. Reject array/scalar roots up front with a clear error rather than
        // failing opaquely after paying for every participant's call.
        const rootType = request.responseFormat.schema.type;
        if (typeof rootType === "string" && rootType !== "object") {
          throw new Error(
            `The "ensemble" strategy requires an object schema (its field-wise vote needs named fields); got a "${rootType}" schema.`,
          );
        }
        return ensemble(roster, request, options?.onEvent);
      }
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
    return this.#providers.has(name);
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

/** Build the {@link Provider} for a custom registry entry registered under `name`. */
function constructCustom(name: string, custom: CustomProviderConfig): Provider {
  switch (custom.kind) {
    case "openai-compatible":
      // The OpenAI provider already speaks Chat Completions against any baseUrl,
      // so an OpenAI-compatible gateway is just it pointed elsewhere. Pass `name`
      // so its errors attribute to this gateway, not a hardcoded "openai".
      return new OpenAIProvider(
        {
          apiKey: custom.apiKey,
          baseUrl: custom.baseUrl,
          model: custom.model,
          headers: custom.headers,
          retry: custom.retry,
        },
        name,
      );
    case "provider":
      return custom.provider;
    default: {
      // Exhaustiveness guard: a future `kind` added without a case here becomes a
      // compile error rather than silently returning undefined (noImplicitReturns
      // is off). Mirrors the strategy switch in combine().
      const unreachable: never = custom;
      throw new Error(
        `Unhandled custom provider kind: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
