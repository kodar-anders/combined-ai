/**
 * Provider registry — the package's single point of access to its providers.
 *
 * You configure the registry with the providers you want (and their API keys);
 * the library constructs the built-in providers by name and hands one back via
 * {@link ProviderRegistry.select}. Consumers never import the provider classes
 * directly. It never reads env vars — keys are always passed in the config.
 */

import {
  type BroadcastRequest,
  type BroadcastResult,
  type CombineEmbedding,
  type CombineOptions,
  type CombineRequest,
  type CombineRequestBase,
  type CombineResult,
  type ConsensusRequest,
  type ConsensusResult,
  type EnsembleRequest,
  type EnsembleResult,
  type ParticipantSpec,
  type PipelineRequest,
  type PipelineResult,
  type ResultFor,
  type StrategyName,
  STRATEGY_NAMES,
} from "./combine";
import { broadcast as runBroadcast } from "./combine/broadcast";
import { type ResolvedEmbedder } from "./combine/embedding";
import { consensus as runConsensus } from "./combine/consensus";
import { ensemble as runEnsemble } from "./combine/ensemble";
import { pipeline as runPipeline } from "./combine/pipeline";
import { type RosterEntry } from "./combine/shared";
import {
  createFallbackProvider,
  type FallbackEntry,
  type FallbackOptions,
  type FallbackSpec,
} from "./fallback";
import {
  AnthropicProvider,
  type AnthropicProviderOptions,
} from "./providers/anthropic";
import { GoogleProvider, type GoogleProviderOptions } from "./providers/google";
import { OpenAIProvider, type OpenAIProviderOptions } from "./providers/openai";
import { assertValidTimeoutMs, type RetryOptions } from "./transport";
import {
  type EmbeddingOptions,
  type EmbeddingResult,
  type Provider,
  type Usage,
} from "./types";

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
  OpenAICompatibleConfig | CustomProviderInstance;

/** The names the library constructs as built-in providers (the single source of truth). */
const BUILT_IN_NAMES = ["anthropic", "openai", "google"] as const;

/** The provider names the library constructs from its own config. */
export type BuiltInProviderName = (typeof BUILT_IN_NAMES)[number];

/** Per-provider configuration. Include a provider's key to register it. */
export type ProviderRegistryConfig = {
  anthropic?: AnthropicProviderOptions;
  openai?: OpenAIProviderOptions;
  google?: GoogleProviderOptions;
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
  BuiltInProviderName | (string & Record<never, never>);

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
    if (config.google) {
      this.#providers.set("google", new GoogleProvider(config.google));
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
   * Combine several configured providers to cooperate on one prompt, dispatching
   * on `request.strategy` (defaults to `"consensus"`).
   *
   * Generic over the strategy: `S` is inferred from the `strategy` field, so a
   * **literal** `strategy` at the call site makes the return that strategy's
   * concrete result (e.g. `strategy: "ensemble"` → `EnsembleResult`) — the caller
   * does **not** narrow a union. When `strategy` is only known at runtime, `S`
   * widens to {@link StrategyName} and the return is the full
   * {@link CombineResult} union to narrow.
   *
   * The request stays the broad {@link CombineRequest} here; for compile-time
   * enforcement of a strategy's specific options (e.g. `responseFormat` required
   * for ensemble) call the per-strategy method ({@link ProviderRegistry.consensus},
   * {@link ProviderRegistry.pipeline}, {@link ProviderRegistry.ensemble},
   * {@link ProviderRegistry.broadcast}), which takes that strategy's request type.
   */
  async combine<S extends StrategyName = "consensus">(
    request: Omit<CombineRequest, "strategy"> & { strategy?: S },
    options?: CombineOptions,
  ): Promise<ResultFor<S>> {
    const strategy: StrategyName = request.strategy ?? "consensus";
    const knownStrategies: readonly string[] = STRATEGY_NAMES;
    if (!knownStrategies.includes(strategy)) {
      throw new Error(
        `Unknown combine strategy "${strategy}". Known: ${STRATEGY_NAMES.join(", ")}`,
      );
    }
    let result: CombineResult;
    switch (strategy) {
      case "consensus":
        result = await this.consensus(request, options);
        break;
      case "pipeline":
        result = await this.pipeline(request, options);
        break;
      case "ensemble":
        // The request is the broad type here; the `ensemble` method re-checks
        // responseFormat at runtime (it's required by EnsembleRequest's type).
        result = await this.ensemble(request as EnsembleRequest, options);
        break;
      case "broadcast":
        result = await this.broadcast(request, options);
        break;
      default: {
        const unreachable: never = strategy;
        throw new Error(`Unhandled combine strategy "${String(unreachable)}"`);
      }
    }
    return result as ResultFor<S>;
  }

  /**
   * Run the `consensus` strategy (draft → critique → synthesize) over the
   * configured participants. Strategy-specific: `synthesizer` (defaults to the
   * first participant), `attribution`, `minParticipants` (default 2).
   */
  async consensus(
    request: ConsensusRequest,
    options?: CombineOptions,
  ): Promise<ConsensusResult> {
    const { roster, ids, firstId } = this.#prepare(request);
    this.#rejectResponseFormat(request, "consensus");
    this.#validateConsensusOptions(request, ids);
    const synthesizer = request.synthesizer ?? firstId;
    const embedder = this.#resolveEmbedder(options?.embedding);
    return runConsensus(roster, synthesizer, request, options, embedder);
  }

  /**
   * Run the `pipeline` strategy (sequential refinement) — participants refine a
   * running answer in roster order; the last advancing stage wins.
   */
  async pipeline(
    request: PipelineRequest,
    options?: CombineOptions,
  ): Promise<PipelineResult> {
    const { roster } = this.#prepare(request);
    this.#rejectResponseFormat(request, "pipeline");
    return runPipeline(roster, request, options);
  }

  /**
   * Run the `ensemble` strategy (multi-model vote on structured output) — every
   * participant answers under `request.responseFormat`; the typed objects are
   * merged field-wise by majority vote with a per-field agreement score.
   */
  async ensemble(
    request: EnsembleRequest,
    options?: CombineOptions,
  ): Promise<EnsembleResult> {
    const { roster } = this.#prepare(request);
    // responseFormat is required by the type, but a JS caller (or the `combine`
    // dispatcher's cast) can still omit it — re-check at runtime.
    const { responseFormat } = request as CombineRequest;
    if (responseFormat === undefined) {
      throw new Error(
        'The "ensemble" strategy requires a responseFormat (the JSON Schema every participant answers under).',
      );
    }
    // The field-wise merge needs named fields, so the schema's root must be an
    // object. Reject array/scalar roots up front with a clear error rather than
    // failing opaquely after paying for every participant's call.
    const rootType = responseFormat.schema.type;
    if (typeof rootType === "string" && rootType !== "object") {
      throw new Error(
        `The "ensemble" strategy requires an object schema (its field-wise vote needs named fields); got a "${rootType}" schema.`,
      );
    }
    const embedder = this.#resolveEmbedder(options?.embedding);
    return runEnsemble(roster, request, options, embedder);
  }

  /**
   * Run the `broadcast` strategy (fan-out, no combine) — every participant
   * answers the raw prompt in parallel; all raw responses are returned.
   */
  async broadcast(
    request: BroadcastRequest,
    options?: CombineOptions,
  ): Promise<BroadcastResult> {
    const { roster } = this.#prepare(request);
    this.#rejectResponseFormat(request, "broadcast");
    const embedder = this.#resolveEmbedder(options?.embedding);
    return runBroadcast(roster, request, options, embedder);
  }

  /**
   * Build a {@link Provider} that tries the given providers in order, falling back
   * to the next when one throws a {@link ProviderError} (a provider being down,
   * rate-limited past its retries, erroring, etc.). Pairs with the per-provider
   * retry in `transport.ts` — each entry still retries routine statuses internally
   * before the chain moves on.
   *
   * The returned provider is a plain {@link Provider}: call `complete()`/`stream()`
   * on it directly, or register it as a `custom: { kind: "provider" }` entry. It has
   * no `embed` (fallback is completion routing; cross-provider embeddings aren't
   * comparable).
   *
   * A `specs` entry is a bare provider name (its default model) or
   * `{ provider, model?, maxTokens? }` whose overrides beat the per-call request
   * (entry → request → provider default) — set `model` per entry for a mixed chain,
   * since one `request.model` can't be forwarded to every provider. By default it
   * falls back on any non-abort `ProviderError`; narrow that with
   * `options.shouldFallback` and observe advances with `options.onFallback`.
   *
   * @throws if `specs` is empty, or names a provider that isn't configured.
   */
  fallback(specs: FallbackSpec[], options?: FallbackOptions): Provider {
    if (specs.length === 0) {
      throw new Error("fallback requires at least one provider");
    }
    const entries: FallbackEntry[] = specs.map((spec) => {
      const { providerName, model, maxTokens } = normalizeFallbackSpec(spec);
      return {
        providerName,
        model,
        maxTokens,
        provider: this.select(providerName),
      };
    });
    return createFallbackProvider(entries, options);
  }

  /**
   * Embed a single text with the named provider — sugar over {@link embedMany}
   * that returns the one vector. Throws if the provider isn't configured or
   * doesn't support embeddings.
   */
  async embed(
    name: ProviderName,
    text: string,
    options?: EmbeddingOptions,
  ): Promise<{ embedding: number[]; model: string; usage?: Usage }> {
    const result = await this.embedMany(name, [text], options);
    const [embedding] = result.embeddings;
    if (embedding === undefined) {
      throw new Error(
        `Provider "${name}" returned no embedding for the input.`,
      );
    }
    return { embedding, model: result.model, usage: result.usage };
  }

  /**
   * Embed several texts with the named provider in one call; returns one vector
   * per input, in order. Throws if the provider isn't configured or doesn't
   * support embeddings.
   */
  async embedMany(
    name: ProviderName,
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<EmbeddingResult> {
    const provider = this.#selectEmbedder(name);
    return provider.embed({ input: texts, ...options });
  }

  /**
   * Shared combine validation: normalize the participant specs, enforce ≥1
   * participant with unique ids, require ≥1 message, and reject tool calling
   * (no strategy supports it). Returns the resolved roster, the participant ids,
   * and the first participant's id (the default consensus synthesizer).
   */
  #prepare(request: CombineRequestBase): {
    roster: RosterEntry[];
    ids: string[];
    firstId: string;
  } {
    // Normalize each participant spec to its id + provider + per-participant
    // overrides. Two participants resolving to the same id (e.g. the same
    // provider+model twice without an explicit `label`) is rejected.
    const normalized = request.participants.map((spec) =>
      normalizeParticipant(spec),
    );
    const [first] = normalized;
    if (first === undefined) {
      throw new Error("combine requires at least one participant");
    }
    const ids = normalized.map((p) => p.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(
        `combine participant labels must be unique: ${ids.join(", ")}. ` +
          "Set a distinct `label` when two participants share a provider and model.",
      );
    }
    if (request.messages.length === 0) {
      throw new Error("combine requires at least one message");
    }
    // No combine strategy does tool calling (a multi-model tool loop has no
    // coherent shared state), and `completionFor` doesn't forward these — so
    // reject them loudly instead of silently ignoring a tools-bearing request.
    if (request.tools !== undefined || request.toolChoice !== undefined) {
      throw new Error(
        "combine does not support tool calling (tools/toolChoice); use registry.select() for a single-provider tool loop.",
      );
    }
    // Validate `timeoutMs` up front: `completionFor` forwards it into every
    // participant call, and each of those runs through `runOutcome`, which would
    // otherwise catch the validation throw as N participant failures and bury it.
    assertValidTimeoutMs(request.timeoutMs);
    const roster: RosterEntry[] = normalized.map((p) => ({
      ...p,
      provider: this.select(p.providerName),
    }));
    return { roster, ids, firstId: first.id };
  }

  /**
   * Reject `responseFormat` on a non-ensemble strategy. It only means something
   * for ensemble (where every participant answers under the schema); on the prose
   * strategies it would be silently forwarded, so reject it loudly instead.
   */
  #rejectResponseFormat(
    request: CombineRequestBase,
    strategy: StrategyName,
  ): void {
    if (request.responseFormat !== undefined) {
      throw new Error(
        `responseFormat is only supported by the "ensemble" strategy, not "${strategy}".`,
      );
    }
  }

  /** Validate the consensus-only request options (`minParticipants`, `synthesizer`). */
  #validateConsensusOptions(request: ConsensusRequest, ids: string[]): void {
    const { minParticipants } = request;
    if (minParticipants !== undefined) {
      if (!Number.isSafeInteger(minParticipants) || minParticipants < 1) {
        throw new Error("combine minParticipants must be a positive integer");
      }
      if (minParticipants > ids.length) {
        throw new Error(
          `combine minParticipants (${String(minParticipants)}) cannot exceed the number of participants (${String(ids.length)})`,
        );
      }
    }
    if (
      request.synthesizer !== undefined &&
      !ids.includes(request.synthesizer)
    ) {
      throw new Error(
        `Synthesizer "${request.synthesizer}" must be one of the participants: ${ids.join(", ")}`,
      );
    }
  }

  /**
   * Select a provider that supports embeddings, or throw. Centralizes the
   * "configured (via {@link select}) AND implements `embed`" check so both the
   * standalone embed methods and the (future) combine embedding path share one
   * error path.
   */
  #selectEmbedder(
    name: ProviderName,
  ): Provider & { embed: NonNullable<Provider["embed"]> } {
    const provider = this.select(name);
    if (provider.embed === undefined) {
      throw new Error(`Provider "${name}" does not support embeddings.`);
    }
    return provider as Provider & { embed: NonNullable<Provider["embed"]> };
  }

  /**
   * Resolve a {@link CombineEmbedding} option to a {@link ResolvedEmbedder} for the
   * combine orchestrators (or `undefined` when no embedding was requested).
   * Validates the provider is configured and supports `embed` up front (via
   * {@link #selectEmbedder}), so a bad embedding provider fails before any
   * participant call rather than after paying for the run.
   */
  #resolveEmbedder(
    embedding: CombineEmbedding | undefined,
  ): ResolvedEmbedder | undefined {
    if (embedding === undefined) {
      return undefined;
    }
    return {
      name: embedding.provider,
      provider: this.#selectEmbedder(embedding.provider),
      model: embedding.model,
    };
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

/**
 * Resolve a {@link ParticipantSpec} to its id, provider name, and per-participant
 * overrides. A bare string uses the provider's default model and an id equal to
 * the provider name; the object form derives the id as `<provider>-<model>` when a
 * model is set (else the provider name), unless an explicit `label` is given.
 */
function normalizeParticipant(
  spec: ParticipantSpec,
): Omit<RosterEntry, "provider"> {
  if (typeof spec === "string") {
    return { id: spec, providerName: spec };
  }
  // Reject falsy overrides up front: `??` in completionFor preserves "" / 0, so an
  // empty model would be sent to the API (and yield a malformed `<provider>-` id)
  // and a non-positive maxTokens would truncate — omit the field to use the default.
  if (spec.model?.trim() === "") {
    throw new Error(
      `combine participant for "${spec.provider}" has an empty model; omit \`model\` to use the default.`,
    );
  }
  if (
    spec.maxTokens !== undefined &&
    (!Number.isSafeInteger(spec.maxTokens) || spec.maxTokens < 1)
  ) {
    throw new Error(
      `combine participant for "${spec.provider}" has an invalid maxTokens (${String(spec.maxTokens)}); must be a positive integer.`,
    );
  }
  const id =
    spec.label ??
    (spec.model === undefined
      ? spec.provider
      : `${spec.provider}-${spec.model}`);
  return {
    id,
    providerName: spec.provider,
    model: spec.model,
    maxTokens: spec.maxTokens,
  };
}

/**
 * Resolve a {@link FallbackSpec} to its provider name and per-entry overrides. A
 * bare string uses the provider's default model; the object form's overrides are
 * validated with the same falsy-guard as {@link normalizeParticipant} (an empty
 * `model` would be sent to the API; a non-positive `maxTokens` would truncate).
 */
function normalizeFallbackSpec(spec: FallbackSpec): {
  providerName: ProviderName;
  model?: string;
  maxTokens?: number;
} {
  if (typeof spec === "string") {
    return { providerName: spec };
  }
  if (spec.model?.trim() === "") {
    throw new Error(
      `fallback entry for "${spec.provider}" has an empty model; omit \`model\` to use the default.`,
    );
  }
  if (
    spec.maxTokens !== undefined &&
    (!Number.isSafeInteger(spec.maxTokens) || spec.maxTokens < 1)
  ) {
    throw new Error(
      `fallback entry for "${spec.provider}" has an invalid maxTokens (${String(spec.maxTokens)}); must be a positive integer.`,
    );
  }
  return {
    providerName: spec.provider,
    model: spec.model,
    maxTokens: spec.maxTokens,
  };
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
