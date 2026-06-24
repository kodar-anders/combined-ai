/**
 * A tiny, hand-maintained model registry: per-token pricing keyed by model id,
 * plus the resolver that maps a provider-reported model string to a table entry.
 *
 * This is the data layer for the cost helpers in `cost.ts` (kept separate so the
 * volatile table and the stable cost math evolve independently — mirrors the
 * `errors.ts` / `transport.ts` split).
 *
 * **Pricing is best-effort and goes stale.** A wrong price is worse than an
 * absent one (a confident wrong number can land in a billing dashboard), so the
 * table is kept small — the most commonly used models across the three providers,
 * not an exhaustive catalog — resolution refuses to guess (see {@link findModel}),
 * and every lookup accepts an `options.models` override to correct or extend it
 * without waiting for a release. See {@link PRICING_VERIFIED_ON} for when these
 * numbers were last checked.
 *
 * Prices verified 2026-06-24 against:
 * - Anthropic: https://platform.claude.com/docs/en/pricing
 * - OpenAI:    https://developers.openai.com/api/docs/pricing
 * - Google:    https://ai.google.dev/gemini-api/docs/pricing
 */

/** USD price per 1,000,000 tokens — the unit every provider publishes. */
export type ModelPricing = {
  /** Price per 1M input (prompt) tokens, in USD. */
  inputPerMTok: number;
  /** Price per 1M output (completion) tokens, in USD. */
  outputPerMTok: number;
  /**
   * A higher pricing tier some models charge for large-context requests (e.g.
   * Gemini 2.5 Pro doubles its rate above 200k prompt tokens). When set, the cost
   * helpers switch **both** input and output to these rates once a request's prompt
   * exceeds `aboveInputTokens`. Omit for the (common) flat-priced models.
   */
  highTier?: {
    /** Prompt-token count above which `highTier` rates apply (exclusive). */
    aboveInputTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
  };
};

/** A resolved model registry entry: its canonical id and pricing. */
export type ModelInfo = {
  /** The canonical table key this entry resolved to (not the queried string). */
  id: string;
  pricing: ModelPricing;
};

/**
 * Options accepted by {@link findModel} and the cost helpers. `models` is an
 * extra/override pricing table merged **over** the built-in one (a colliding key
 * wins), so callers can price their own models or correct a stale built-in entry
 * without a library release.
 */
export type CostOptions = {
  models?: Record<string, ModelPricing>;
};

/**
 * The date the {@link MODELS} prices were last verified, as an ISO `YYYY-MM-DD`
 * string. Exposed so callers can reason about staleness programmatically.
 */
export const PRICING_VERIFIED_ON = "2026-06-24";

/**
 * The built-in pricing table — the most commonly used models across the three
 * providers (current + recent generations, and the cheap tiers). Anything else
 * resolves via the `options.models` override. Not exported directly: its shape is
 * an implementation detail, so access goes through {@link findModel} /
 * {@link listModels}.
 *
 * Gemini 2.5 Pro is tiered ($1.25/$10.00 ≤200k prompt tokens, $2.50/$15.00 above),
 * carried via {@link ModelPricing.highTier} so the cost helpers pick the right tier
 * from the request's prompt size.
 */
const MODELS: Record<string, ModelPricing> = {
  // Anthropic
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // Google (Gemini)
  "gemini-2.5-pro": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    highTier: {
      aboveInputTokens: 200_000,
      inputPerMTok: 2.5,
      outputPerMTok: 15,
    },
  },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // Embeddings (input-only; `outputPerMTok: 0`). Each full id is its own exact
  // key — the digit-suffix resolver (see findModel) would not resolve a word
  // suffix like `-small`/`-large` from a `text-embedding-3` base.
  "text-embedding-3-small": { inputPerMTok: 0.02, outputPerMTok: 0 },
  "text-embedding-3-large": { inputPerMTok: 0.13, outputPerMTok: 0 },
  "gemini-embedding-001": { inputPerMTok: 0.15, outputPerMTok: 0 },
};

/**
 * Resolve a provider-reported model string to its {@link ModelInfo}, or
 * `undefined` if unknown (the normal case for custom/unconfigured models).
 *
 * Resolution, against the built-in table merged with `options.models` (overrides
 * win on a key collision):
 * 1. **Exact** key match.
 * 2. **Dated-snapshot prefix**: a key `k` matches when the reported id is `k`
 *    followed by `"-"` and a **digit** — i.e. a date/version snapshot such as
 *    `gpt-4.1-2025-04-14` → `gpt-4.1` or `claude-opus-4-8-20250101` → `claude-opus-4-8`.
 *    The longest such key wins (so `gpt-4.1-mini-2025-04-14` → `gpt-4.1-mini`,
 *    not `gpt-4.1`).
 *
 * The digit requirement is deliberate: a **sibling** model whose suffix is a word
 * (`gpt-4.1-nano`, `gemini-2.5-flash-lite`) is priced differently by the provider,
 * so it must **not** inherit a base key's price. Such ids return `undefined` (price
 * them via `options.models`) rather than a confident wrong number — matching this
 * module's "absent beats wrong" stance. (Namespaced gateway ids like
 * `openai/gpt-4.1` don't start with a key and miss for the same reason.)
 *
 * The returned `pricing` is a fresh copy, so mutating it can't corrupt the registry.
 */
export function findModel(
  model: string,
  options?: CostOptions,
): ModelInfo | undefined {
  // Common path: no overrides → search MODELS directly (no merge allocation).
  const overrides = options?.models;
  return resolve(model, overrides ? { ...MODELS, ...overrides } : MODELS);
}

/** Exact-then-dated-snapshot resolution over a single (already-merged) table. */
function resolve(
  model: string,
  table: Record<string, ModelPricing>,
): ModelInfo | undefined {
  const exact = table[model];
  if (exact !== undefined) {
    return { id: model, pricing: clonePricing(exact) };
  }
  // Carry the matched pricing alongside the key (per CLAUDE.md: don't re-index by
  // key after the loop) and keep the longest matching key.
  let best: ModelInfo | undefined;
  for (const [key, pricing] of Object.entries(table)) {
    if (!model.startsWith(`${key}-`)) {
      continue;
    }
    // Only a date/version snapshot (next char is a digit) is the same model; a
    // word suffix (`-nano`, `-lite`, `-mini`) is a differently-priced sibling.
    const snapshotChar = model.charAt(key.length + 1);
    if (snapshotChar < "0" || snapshotChar > "9") {
      continue;
    }
    if (best === undefined || key.length > best.id.length) {
      best = { id: key, pricing };
    }
  }
  return best === undefined
    ? undefined
    : { id: best.id, pricing: clonePricing(best.pricing) };
}

/**
 * The built-in models, as a fresh array of `{ id, pricing }` (a copy — mutating
 * it does not affect the registry). Does not include `options.models` overrides,
 * which are per-call.
 */
export function listModels(): ModelInfo[] {
  return Object.entries(MODELS).map(([id, pricing]) => ({
    id,
    pricing: clonePricing(pricing),
  }));
}

/** A deep-enough copy of a pricing entry so callers can't mutate the registry. */
function clonePricing(pricing: ModelPricing): ModelPricing {
  return pricing.highTier === undefined
    ? { ...pricing }
    : { ...pricing, highTier: { ...pricing.highTier } };
}
