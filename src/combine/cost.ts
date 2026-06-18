/**
 * Price a finished combine in dollars. A combine makes several model calls (a
 * default 3-way consensus is ~8), so the single-result {@link costOf} isn't enough;
 * {@link combineCost} sums the per-call costs from the result's {@link CombineUsage.calls}
 * ledger.
 *
 * Lives here (not in `cost.ts`) so the lower `cost.ts` layer stays about single
 * results and doesn't import combine types — the runtime dependency points one way,
 * `combine → cost` (this module imports {@link costOfUsage}), with no cycle.
 *
 * **Prices each call individually** (never the pre-summed {@link CombineUsage.byParticipant}):
 * summing a participant's calls and pricing the sum would mishandle tiered rates
 * (a model's high tier triggers on a single call's prompt size, not a summed one)
 * and the per-call thinking-token residual. Mirrors `cost.ts`'s "wrong price is
 * worse than absent" stance — a call whose model can't be priced is skipped, so the
 * total can understate; `undefined` is returned only when nothing was priceable.
 */

import { type CombineResult } from "./index";
import { costOfUsage } from "../cost";
import { type CostOptions } from "../models";

/**
 * A combine's cost in USD: the `totalCost` across every priceable call, plus a
 * `byParticipant` breakdown keyed by participant id. Note this differs from
 * {@link CombineUsage.byParticipant} (which counts tokens for *all* calls): a call
 * whose model isn't in the pricing registry is omitted here, so a participant whose
 * every call was unpriceable is absent from `byParticipant` (absent reads truer
 * than a `0` that looks free).
 */
export type CombineCost = {
  /** Total cost in USD across every priceable call. */
  totalCost: number;
  /** Total USD per participant id (priceable calls only). */
  byParticipant: Partial<Record<string, number>>;
};

/**
 * Price a finished {@link CombineResult}, or `undefined` when nothing can be priced
 * — the result carries no usage, its per-call ledger is empty, or every call's
 * model is unknown to the registry. `options.models` extends or overrides the
 * built-in pricing table (e.g. to price custom-provider models).
 *
 * Each call in `result.usage.calls` is priced individually via {@link costOfUsage};
 * unpriceable calls are skipped, so `totalCost` can understate a run that mixed
 * known and unknown models.
 */
export function combineCost(
  result: CombineResult,
  options?: CostOptions,
): CombineCost | undefined {
  const calls = result.usage?.calls;
  if (calls === undefined || calls.length === 0) {
    return undefined;
  }
  const byParticipant: Partial<Record<string, number>> = {};
  let totalCost = 0;
  for (const call of calls) {
    const cost = costOfUsage(call.usage, call.model, options);
    if (cost === undefined) {
      continue;
    }
    totalCost += cost.totalCost;
    byParticipant[call.id] = (byParticipant[call.id] ?? 0) + cost.totalCost;
  }
  // byParticipant gets a key iff a call priced, so an empty map means nothing was
  // priceable (mirrors aggregateUsage's "no usage at all → undefined").
  return Object.keys(byParticipant).length === 0
    ? undefined
    : { totalCost, byParticipant };
}
