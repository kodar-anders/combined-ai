/**
 * Turn the token {@link Usage} the providers return into dollars, using the tiny
 * built-in pricing registry (`models.ts`). Pure and stateless — these are plain
 * functions, not registry methods, since pricing a result needs no configuration.
 *
 * Both entry points return `undefined` (never throw) when the model is unknown or
 * usage is missing — both are normal for custom/unconfigured providers, and a
 * "show cost if you can" helper shouldn't make callers guard against exceptions.
 * This mirrors the library's optional-field grain (`usage`/`parsed`/… are set
 * only when present).
 */

import { findModel, type CostOptions } from "./models";
import { type CompletionResult, type Usage } from "./types";

/**
 * A computed cost decomposition, in USD. `model` is the canonical registry key
 * the usage was priced against (the resolved table key, which may differ from the
 * queried string — e.g. a dated snapshot resolves to its base id). Costs are raw
 * floating-point dollars; round at display time, and note that summing many small
 * costs accumulates float error.
 */
export type CostBreakdown = {
  /** The canonical model id the usage was priced against. */
  model: string;
  /** Cost of the input (prompt) tokens, in USD. */
  inputCost: number;
  /** Cost of the output (completion) tokens, in USD. */
  outputCost: number;
  /** `inputCost + outputCost`, in USD. */
  totalCost: number;
};

/**
 * Price a raw {@link Usage} against `model`, or `undefined` if the model isn't in
 * the registry (see {@link findModel} for resolution) or the usage is unusable.
 * `options.models` extends or overrides the built-in table.
 *
 * **Unusable usage → `undefined`.** A real completion always consumes prompt
 * tokens, so `inputTokens <= 0` means the usage block was missing, empty (`{}`), or
 * malformed (e.g. a gateway that dropped `prompt_tokens`). Pricing that would
 * produce a confident wrong number — a `$0.00` that reads as "free", or input
 * tokens mis-billed at the output rate via the thinking residual below — so we
 * decline and return `undefined` instead.
 *
 * **Tiered pricing.** When the model has a {@link ModelPricing.highTier} and the
 * prompt exceeds its threshold (e.g. Gemini 2.5 Pro above 200k tokens), both input
 * and output bill at the higher tier.
 *
 * **Gemini thinking tokens** count against the output rate but are excluded from
 * `outputTokens` (the visible-output count) while included in `totalTokens`. So we
 * bill `outputTokens` plus any positive residual `totalTokens - inputTokens -
 * outputTokens` at the output rate. For Anthropic/OpenAI that residual is 0, so
 * they're unaffected. (We never price off `totalTokens` directly — its definition
 * differs across providers.)
 */
export function costOfUsage(
  usage: Usage,
  model: string,
  options?: CostOptions,
): CostBreakdown | undefined {
  if (usage.inputTokens <= 0) {
    return undefined;
  }
  const info = findModel(model, options);
  if (info === undefined) {
    return undefined;
  }
  const { highTier } = info.pricing;
  const tier =
    highTier !== undefined && usage.inputTokens > highTier.aboveInputTokens
      ? highTier
      : info.pricing;
  const { inputPerMTok, outputPerMTok } = tier;
  const thinkingTokens = Math.max(
    0,
    usage.totalTokens - usage.inputTokens - usage.outputTokens,
  );
  const billableOutputTokens = usage.outputTokens + thinkingTokens;
  // Multiply before dividing to keep the intermediate within safe-integer range
  // and minimize float error (token counts and per-MTok prices are small).
  const inputCost = (usage.inputTokens * inputPerMTok) / 1_000_000;
  const outputCost = (billableOutputTokens * outputPerMTok) / 1_000_000;
  return {
    model: info.id,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Price a {@link CompletionResult}. Returns `undefined` when the result carries no
 * `usage` (the provider reported none) or the model is unknown. Delegates to
 * {@link costOfUsage}.
 */
export function costOf(
  result: CompletionResult,
  options?: CostOptions,
): CostBreakdown | undefined {
  if (result.usage === undefined) {
    return undefined;
  }
  return costOfUsage(result.usage, result.model, options);
}
