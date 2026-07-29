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
  /**
   * How many entries **in the ledger** could not be priced — their model is unknown to
   * the registry, or their usage reported no prompt tokens (see {@link costOfUsage}) —
   * and are therefore excluded from `totalCost`. Anything above `0` means `totalCost`
   * understates, by an unknown amount; pass `options.models` to price custom-provider
   * models.
   *
   * **`0` does not mean `totalCost` covers the whole run.** It means everything that
   * reached the ledger priced. A call that reported *no usage at all* never enters
   * {@link CombineUsage.calls} in the first place (`aggregateUsage` keeps only entries
   * carrying both a model and usage), so `combineCost` cannot see it and cannot count
   * it here. That is a real case, not a hypothetical: Gemini's embedding endpoint
   * reports no usage, and OpenAI-compatible gateways often omit it on completions — so
   * a run using either has billed calls that are invisible to both `totalCost` and
   * `unpriced`. Treat this as "how much of the ledger I had to skip", not as an
   * all-clear; compare `usage.total` against the run's expected call count if you need
   * to detect unmetered calls.
   *
   * Only ever observable alongside at least one priced call: a run where *nothing*
   * priced returns `undefined` rather than a `CombineCost`, so this can never equal
   * `usage.calls.length`.
   */
  unpriced: number;
};

/**
 * Price a finished {@link CombineResult}, or `undefined` when nothing can be priced
 * — the result carries no usage, its per-call ledger is empty, or every call's
 * model is unknown to the registry. `options.models` extends or overrides the
 * built-in pricing table (e.g. to price custom-provider models).
 *
 * Each call in `result.usage.calls` is priced individually via {@link costOfUsage};
 * unpriceable calls are skipped, so `totalCost` can understate a run that mixed
 * known and unknown models — {@link CombineCost.unpriced} counts how many, so a
 * genuinely cheap run is distinguishable from a partly-unpriced one.
 */
export function combineCost(
  result: CombineResult,
  options?: CostOptions,
): CombineCost | undefined {
  const calls = result.usage?.calls;
  if (calls === undefined || calls.length === 0) {
    return undefined;
  }
  // Accumulate in a Map, then `Object.fromEntries` — never `record[id] = …`. A
  // participant id of `__proto__` (an explicit `label`, or a hand-built ledger) would
  // otherwise hit the prototype setter: `byParticipant["__proto__"] ?? 0` reads
  // `Object.prototype` instead of `undefined`, so the running sum turns into a string,
  // the assignment is silently dropped, and the "nothing priced" check below then
  // returns `undefined` for a run where every call priced. Same reasoning as
  // `mergeObjects` in `ensemble.ts`.
  const perParticipant = new Map<string, number>();
  let totalCost = 0;
  let unpriced = 0;
  for (const call of calls) {
    const cost = costOfUsage(call.usage, call.model, options);
    if (cost === undefined) {
      unpriced += 1;
      continue;
    }
    totalCost += cost.totalCost;
    perParticipant.set(
      call.id,
      (perParticipant.get(call.id) ?? 0) + cost.totalCost,
    );
  }
  // The map gets a key iff a call priced, so an empty one means nothing was priceable
  // (mirrors aggregateUsage's "no usage at all → undefined").
  return perParticipant.size === 0
    ? undefined
    : {
        totalCost,
        byParticipant: Object.fromEntries(perParticipant),
        unpriced,
      };
}
