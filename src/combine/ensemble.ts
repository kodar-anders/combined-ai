/**
 * The **ensemble** combine strategy: every participant answers the prompt
 * independently under the *same* JSON Schema (`request.responseFormat`), then the
 * resulting typed objects are merged **mechanically** — no LLM synthesis. This is
 * the multi-model differentiator: where consensus has a model adjudicate prose,
 * ensemble does a deterministic field-wise vote over structured output and reports
 * how strongly the models agreed, a confidence signal a single model can't give.
 *
 * Merge policy (field-wise over the union of top-level keys):
 * - every field → **majority vote**: the most common value by deep equality, ties
 *   broken by first-seen participant order. The merged value is therefore always a
 *   value some model actually returned — never a synthesized/averaged one — so it
 *   stays within the schema's types and the agreement score below describes the
 *   exact value you get back.
 * - per-field **agreement** = the fraction of the valid responses that agreed on
 *   the merged value. The denominator is *all* the merged responses (not just the
 *   ones that returned the field), so a field most models omitted scores low —
 *   honest confidence rather than an inflated one.
 * - per-field **votes** = the same vote, itemized: each distinct value with the
 *   participant ids that returned it, plus the ids that omitted the field. It's the
 *   breakdown the two numbers above are computed from, so a caller never has to
 *   re-walk `responses` and reimplement the equality rule to see who dissented.
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
  type EnsembleFieldCandidate,
  type EnsembleFieldVote,
  type EnsembleResult,
} from "./index";
import { fieldSemanticAgreement, type ResolvedEmbedder } from "./embedding";
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
  embedder?: ResolvedEmbedder,
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
  // answer (parsed undefined), or a non-object top-level value (an array included)
  // is dropped. `isPlainObject` narrows `parsed` inside the `&&`, so no cast is
  // needed. The id travels *with* its object rather than in a parallel array — the
  // merge attributes every value to a participant, and zipping two arrays by index
  // is what `noUncheckedIndexedAccess` exists to discourage.
  const valid = responses.flatMap((o) =>
    o.status === "ok" && isPlainObject(o.result.parsed)
      ? [{ id: o.id, object: o.result.parsed }]
      : [],
  );

  if (valid.length === 0) {
    throw noResultError(
      "Ensemble failed: no participant returned a valid structured object.",
      responses,
    );
  }

  const { merged, agreement, votes } = mergeObjects(valid);

  // Optional, informational: a meaning-aware companion to the exact-match vote.
  // For each string-valued field, embed the participants' values (one batch call)
  // and score their mean pairwise similarity. It never changes `merged` — that
  // stays the deterministic exact-match vote. A failure is swallowed.
  const usageEntries = outcomeUsage(responses);
  let semanticAgreement: Record<string, number> | undefined;
  if (embedder !== undefined) {
    try {
      const scored = await fieldSemanticAgreement(
        embedder,
        collectStringFields(valid.map((v) => v.object)),
        request.signal,
      );
      if (scored !== undefined) {
        semanticAgreement = scored.agreement;
        usageEntries.push(scored.usage);
      }
    } catch {
      // Informational; keep the merge we already have.
    }
  }

  return {
    text: JSON.stringify(merged),
    strategy: "ensemble",
    merged,
    agreement,
    votes,
    ...(semanticAgreement === undefined ? {} : { semanticAgreement }),
    responses,
    usage: aggregateUsage(usageEntries),
  };
}

/**
 * Collect each field's **string** values across the valid responses, in
 * first-seen key order. Non-string values are skipped (semantic agreement only
 * applies to free text; enums/numbers/booleans use the exact-match vote).
 */
function collectStringFields(
  objects: Array<Record<string, unknown>>,
): Array<{ key: string; values: string[] }> {
  const byKey = new Map<string, string[]>();
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (typeof value !== "string") {
        continue;
      }
      const values = byKey.get(key);
      if (values === undefined) {
        byKey.set(key, [value]);
      } else {
        values.push(value);
      }
    }
  }
  return [...byKey].map(([key, values]) => ({ key, values }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One participant's valid structured response, kept with the id that produced it. */
type ValidResponse = { id: string; object: Record<string, unknown> };

/**
 * Merge the participant objects field-wise, computing the agreement scores and the
 * per-field vote breakdown in the same pass. `valid` is non-empty.
 */
function mergeObjects(valid: ValidResponse[]): {
  merged: Record<string, unknown>;
  agreement: EnsembleAgreement;
  votes: Record<string, EnsembleFieldVote>;
} {
  // Group each field's values in one pass, each tagged with the participant that
  // returned it. A Map preserves first-seen key order (so the merged object's shape
  // is stable) and per-key participant order (so mergeField's first-seen tie-break
  // is honored).
  const byKey = new Map<string, Array<{ id: string; value: unknown }>>();
  for (const { id, object } of valid) {
    for (const [key, value] of Object.entries(object)) {
      const entries = byKey.get(key);
      if (entries === undefined) {
        byKey.set(key, [{ id, value }]);
      } else {
        entries.push({ id, value });
      }
    }
  }

  const ids = valid.map((v) => v.id);
  // Denominator is the total number of merged responses, not just the ones that
  // returned this field, so a field most models omitted scores low.
  const fields = [...byKey].map(([key, entries]) => ({
    key,
    ...mergeField(entries, valid.length, ids),
  }));

  const overall =
    fields.length === 0
      ? 1
      : fields.reduce((sum, f) => sum + f.agreement, 0) / fields.length;
  // Object.fromEntries, not `{}` + `record[key] = …`: model output reaches here via
  // JSON.parse, which makes `__proto__` an ordinary own enumerable key. Assigning it
  // by index would invoke the prototype setter — silently dropping the field and
  // polluting the record's prototype — while fromEntries defines a real own property.
  return {
    merged: Object.fromEntries(fields.map((f) => [f.key, f.value])),
    agreement: {
      overall,
      byField: Object.fromEntries(fields.map((f) => [f.key, f.agreement])),
      validResponseCount: valid.length,
    },
    votes: Object.fromEntries(fields.map((f) => [f.key, f.vote])),
  };
}

/**
 * Merge one field by majority vote: the most common value (deep equality via
 * {@link stableKey}), ties broken by first-seen participant order. The merged value
 * is always one a model actually returned. `agreement` is the share of all `total`
 * responses that voted for it, and `vote` itemizes the tally. `entries` (the values
 * present for this field) is non-empty — only fields in at least one object reach
 * here. `ids` is every valid participant, in participant order, used to derive which
 * of them omitted the field.
 */
function mergeField(
  entries: Array<{ id: string; value: unknown }>,
  total: number,
  ids: string[],
): { value: unknown; agreement: number; vote: EnsembleFieldVote } {
  // Group equal values, keeping each group's voters. Map insertion order = first-seen
  // participant order, which is what makes the tie-break below deterministic.
  const groups = new Map<string, { value: unknown; ids: string[] }>();
  for (const { id, value } of entries) {
    const key = stableKey(value);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { value, ids: [id] });
    } else {
      group.ids.push(id);
    }
  }

  // The largest group wins. Strict `>` keeps the first-seen group ahead of any later
  // group that merely ties it, so an N-way tie resolves to the value some participant
  // returned first. `winnerKey` can't collide with a real group key: stableKey returns
  // either a non-empty JSON string or (for a non-JSON value) `undefined`, never `""`.
  let winnerKey = "";
  let maxCount = 0;
  let value: unknown;
  for (const [key, group] of groups) {
    if (group.ids.length > maxCount) {
      maxCount = group.ids.length;
      winnerKey = key;
      value = group.value;
    }
  }

  // `absent` by set difference against the voters, not a second `Object.hasOwn` scan
  // over the objects: derived from the same pass that built the candidates, it can't
  // disagree with the vote (a non-enumerable own key on a hand-built object from a
  // BYO provider would be skipped by Object.entries yet pass hasOwn, putting that
  // participant in neither list). Guarantees Σ candidate ids + absent === total.
  const voted = new Set(entries.map((e) => e.id));
  const candidates: EnsembleFieldCandidate[] = [...groups].map(
    ([key, group]) => ({
      value: group.value,
      ids: group.ids,
      winner: key === winnerKey,
    }),
  );
  return {
    value,
    agreement: maxCount / total,
    vote: { candidates, absent: ids.filter((id) => !voted.has(id)) },
  };
}

/**
 * A deep-equality key for tallying values. Object keys are sorted recursively so
 * that two models emitting the same object with different key order count as
 * agreeing. Total for the `JSON.parse` output this runs on, always returning a
 * non-empty JSON string. A hand-built object from a BYO provider can hold a value
 * `JSON.stringify` has no representation for (`undefined`, a function, a symbol);
 * those return `undefined` rather than a string, so they group with each other —
 * harmless, since no schema-conforming model returns them.
 */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (!isPlainObject(val)) {
      return val;
    }
    // eslint-disable-next-line unicorn/no-array-sort, unicorn/require-array-sort-compare -- toSorted() needs ES2023 (lib is ES2022); keys are strings, so the default lexicographic sort is intended.
    const sortedKeys = Object.keys(val).sort();
    return Object.fromEntries(sortedKeys.map((key) => [key, val[key]]));
  });
}
