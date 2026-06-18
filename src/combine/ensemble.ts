/**
 * The **ensemble** combine strategy: every participant answers the prompt
 * independently under the *same* JSON Schema (`request.responseFormat`), then the
 * resulting typed objects are merged **mechanically** — no LLM synthesis. This is
 * the multi-model differentiator: where consensus has a model adjudicate prose,
 * ensemble does a deterministic field-wise vote over structured output and reports
 * how strongly the models agreed, a confidence signal a single model can't give.
 *
 * Merge policy (field-wise over the union of top-level keys):
 * - every field → **majority vote**: the most common value by deep equality,
 *   ties broken by participant order. The merged value is therefore always a
 *   value some model actually returned — never a synthesized/averaged one — so it
 *   stays within the schema's types and the agreement score below describes the
 *   exact value you get back.
 * - per-field **agreement** = the fraction of the valid responses that agreed on
 *   the merged value. The denominator is *all* the merged responses (not just the
 *   ones that returned the field), so a field most models omitted scores low —
 *   honest confidence rather than an inflated one.
 *
 * Builds only on the {@link Provider} contract (`complete()` with the schema) so
 * it needs no provider-specific code; unit-testable with fake providers. The
 * registry requires `responseFormat` for this strategy and rejects it for the
 * others, so by the time this runs `request.responseFormat` is set.
 */

import {
  type CombineOptions,
  type CombineRequest,
  type EnsembleAgreement,
  type EnsembleResult,
} from "./index";
import {
  aggregateUsage,
  makeEmitter,
  noResultError,
  outcomeUsage,
  respondAll,
  type RosterEntry,
} from "./shared";

/**
 * Run the ensemble strategy. `roster` lists the resolved participants. `onEvent`,
 * if given, receives a `response` event as each participant settles. Internal —
 * exposed to consumers only through {@link ProviderRegistry.combine}.
 */
export async function ensemble(
  roster: RosterEntry[],
  request: CombineRequest,
  options?: CombineOptions,
): Promise<EnsembleResult> {
  const emit = makeEmitter(options?.onEvent);
  // `options.budget` is accepted for a uniform API but inert here: a single
  // parallel fan-out has no later phase to gate, so there is nothing to pre-empt.
  // Price the run after the fact with `combineCost(result)` instead.

  // Every participant answers the same prompt under the same schema, in parallel.
  // completionFor (inside respondAll) carries responseFormat through, so each
  // provider returns a parsed object on its result.
  const responses = await respondAll(roster, request, emit);

  // A response counts toward the merge only if it succeeded and parsed into a
  // plain object (the schema's shape); a failed call, an empty/invalid-JSON
  // answer (parsed undefined), or a non-object top-level value is dropped.
  // `isPlainObject` narrows `parsed` inside the `&&`, so no cast is needed.
  const objects = responses.flatMap((o) =>
    o.status === "ok" && isPlainObject(o.result.parsed)
      ? [o.result.parsed]
      : [],
  );

  if (objects.length === 0) {
    throw noResultError(
      "Ensemble failed: no participant returned a valid structured object.",
      responses,
    );
  }

  const { merged, agreement } = mergeObjects(objects);

  return {
    text: JSON.stringify(merged),
    strategy: "ensemble",
    merged,
    agreement,
    responses,
    usage: aggregateUsage(outcomeUsage(responses)),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge the participant objects field-wise and compute the agreement scores. */
function mergeObjects(objects: Array<Record<string, unknown>>): {
  merged: Record<string, unknown>;
  agreement: EnsembleAgreement;
} {
  // Group each field's values in one pass. A Map preserves first-seen key order
  // (so the merged object's shape is stable) and per-key participant order (so
  // mergeField's first-seen tie-break is honored).
  const byKey = new Map<string, unknown[]>();
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      const values = byKey.get(key);
      if (values === undefined) {
        byKey.set(key, [value]);
      } else {
        values.push(value);
      }
    }
  }

  const merged: Record<string, unknown> = {};
  const byField: Record<string, number> = {};
  for (const [key, values] of byKey) {
    // Denominator is the total number of merged responses, not just the ones
    // that returned this field, so a field most models omitted scores low.
    const field = mergeField(values, objects.length);
    merged[key] = field.value;
    byField[key] = field.agreement;
  }

  const scores = Object.values(byField);
  const overall =
    scores.length === 0 ? 1 : scores.reduce((a, b) => a + b, 0) / scores.length;
  return { merged, agreement: { overall, byField } };
}

/**
 * Merge one field by majority vote: the most common value (deep equality via
 * {@link stableKey}, first-seen wins ties). The merged value is always one a model
 * actually returned. `agreement` is the share of all `total` responses that voted
 * for it. `values` (the values present for this field) is non-empty — only fields
 * in at least one object reach here.
 */
function mergeField(
  values: unknown[],
  total: number,
): { value: unknown; agreement: number } {
  const counts = new Map<string, number>();
  let mode: unknown = values[0];
  let maxCount = 0;
  for (const value of values) {
    const key = stableKey(value);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    // Strict `>` means the first value to reach a given count keeps the lead, so
    // ties are broken by first-seen (participant) order.
    if (count > maxCount) {
      maxCount = count;
      mode = value;
    }
  }
  return { value: mode, agreement: maxCount / total };
}

/**
 * A deep-equality key for tallying values. Object keys are sorted recursively so
 * that two models emitting the same object with different key order count as
 * agreeing. (JSON values can't be `undefined`, so `JSON.stringify` is total here.)
 */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (!isPlainObject(val)) {
      return val;
    }
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() needs ES2023; the lib target is ES2022.
    const sortedKeys = Object.keys(val).sort();
    return Object.fromEntries(sortedKeys.map((key) => [key, val[key]]));
  });
}
