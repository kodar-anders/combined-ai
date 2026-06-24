/**
 * Embedding-backed semantic comparison for combine strategies. **Informational
 * only** — it ranks and scores the participants' answers (how much they
 * converged, which one dissents); it never changes a returned or merged value.
 *
 * The dedicated home for combine's embedding logic (mirrors `cost.ts`): used by
 * `broadcast` and `consensus` (whole-answer {@link compareAnswers}) and `ensemble`
 * (per-field {@link fieldSemanticAgreement}). `pipeline` has no parallel answers to
 * compare, so it doesn't use this.
 */

import { type SemanticComparison } from "./index";
import { type UsageEntry } from "./shared";
import { cosineSimilarity } from "../embeddings";
import { type ProviderName } from "../registry";
import { type EmbeddingResult, type Provider } from "../types";

/**
 * A resolved embedding provider: configured AND supporting `embed` (validated by
 * the registry), plus its optional model override and the name it bills under.
 */
export type ResolvedEmbedder = {
  name: ProviderName;
  provider: Provider & { embed: NonNullable<Provider["embed"]> };
  model?: string;
};

/** An answer to compare: the participant id that produced it and its text. */
export type LabeledAnswer = { id: string; text: string };

/**
 * cosine ≥ this ⇒ two answers join the same cluster. A heuristic, deliberately
 * not user-configurable yet: it only shapes the informational `clusters`
 * grouping, never a returned value, so a rough default is fine.
 */
const CLUSTER_THRESHOLD = 0.82;

/**
 * Embed the answers with the designated model and compute their semantic
 * comparison. Returns the comparison plus a {@link UsageEntry} for the billed
 * embedding call (attributed to the embedding provider's name) so it folds into
 * the combine's usage ledger. Returns `undefined` when there's nothing to
 * compare (fewer than two answers) — the caller then omits the field.
 *
 * May throw if the embedding call fails or returns malformed vectors; the caller
 * catches so a failed comparison never fails a run that already has answers.
 */
export async function compareAnswers(
  embedder: ResolvedEmbedder,
  answers: LabeledAnswer[],
  signal?: AbortSignal,
): Promise<{ comparison: SemanticComparison; usage: UsageEntry } | undefined> {
  if (answers.length < 2) {
    return undefined;
  }
  const result = await embedder.provider.embed({
    input: answers.map((a) => a.text),
    model: embedder.model,
    signal,
  });
  // The provider contract is one vector per input, in order. If the count differs
  // we can't trust the positional pairing, so decline rather than score
  // mis-aligned vectors — informational, so no signal beats a wrong one.
  if (result.embeddings.length !== answers.length) {
    return undefined;
  }
  const items = answers.map((answer, i) => ({
    id: answer.id,
    vector: result.embeddings[i] ?? [],
  }));
  const usage = embeddingUsage(embedder, result);
  return { comparison: analyze(items), usage };
}

/**
 * Per-field semantic agreement for `ensemble`: for each field, the mean pairwise
 * cosine similarity of the participants' string values (a meaning-aware companion
 * to the exact-match vote). All values across all fields are embedded in **one**
 * call (embeddings are per-text, so mixing fields in one batch is fine), then
 * sliced back per field. Fields with fewer than two values are skipped. Returns
 * the per-field scores plus the billed call's usage entry, or `undefined` when no
 * field qualified (the caller then omits the field). May throw — the caller
 * catches so a failed comparison never fails the run.
 */
export async function fieldSemanticAgreement(
  embedder: ResolvedEmbedder,
  fields: Array<{ key: string; values: string[] }>,
  signal?: AbortSignal,
): Promise<
  { agreement: Record<string, number>; usage: UsageEntry } | undefined
> {
  const eligible = fields.filter((field) => field.values.length >= 2);
  if (eligible.length === 0) {
    return undefined;
  }
  // Flatten into one batch, remembering each field's slice.
  const inputs: string[] = [];
  const spans: Array<{ key: string; start: number; end: number }> = [];
  for (const field of eligible) {
    const start = inputs.length;
    inputs.push(...field.values);
    spans.push({ key: field.key, start, end: inputs.length });
  }
  const result = await embedder.provider.embed({
    input: inputs,
    model: embedder.model,
    signal,
  });
  // One vector per input, in order, is the provider contract; a different count
  // means the per-field slices below would line up against the wrong vectors and
  // report a confidently wrong number, so decline instead.
  if (result.embeddings.length !== inputs.length) {
    return undefined;
  }
  const agreement: Record<string, number> = {};
  for (const span of spans) {
    agreement[span.key] = meanPairwiseCosine(
      result.embeddings.slice(span.start, span.end),
    );
  }
  return { agreement, usage: embeddingUsage(embedder, result) };
}

/**
 * The usage ledger entry for an embedding call. Tagged `embedding:<provider>` —
 * **not** the bare provider name — so the tokens don't fold into a participant
 * whose id defaults to that same provider name (`byParticipant` would otherwise
 * mix completion and embedding usage under one id).
 */
function embeddingUsage(
  embedder: ResolvedEmbedder,
  result: EmbeddingResult,
): UsageEntry {
  return {
    id: `embedding:${embedder.name}`,
    model: result.model,
    usage: result.usage,
  };
}

type Item = { id: string; vector: number[] };

/** Compute agreement, outlier, and clusters from the embedded answers. */
function analyze(items: Item[]): SemanticComparison {
  const outlier = outlierId(items);
  return {
    agreement: meanPairwiseCosine(items.map((it) => it.vector)),
    ...(outlier === undefined ? {} : { outlier }),
    clusters: clusterBySeed(items),
  };
}

/** Mean cosine similarity over every distinct pair; 1 when fewer than two vectors. */
function meanPairwiseCosine(vectors: number[][]): number {
  let sum = 0;
  let pairs = 0;
  for (const [i, a] of vectors.entries()) {
    for (const b of vectors.slice(i + 1)) {
      sum += cosineSimilarity(a, b);
      pairs += 1;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

/**
 * The id of the answer farthest from the group centroid (lowest cosine to it).
 * `undefined` with fewer than three items — with two, both are equidistant, so
 * there is no meaningful dissenter. Ties resolve to the first in participant
 * order (strict `<`), keeping the result deterministic.
 */
function outlierId(items: Item[]): string | undefined {
  if (items.length < 3) {
    return undefined;
  }
  const centroid = meanVector(items.map((it) => it.vector));
  let outlier: string | undefined;
  let worst = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const similarity = cosineSimilarity(it.vector, centroid);
    if (similarity < worst) {
      worst = similarity;
      outlier = it.id;
    }
  }
  return outlier;
}

/** Element-wise mean of equal-length vectors (all share one embedding model). */
function meanVector(vectors: number[][]): number[] {
  const dims = vectors[0]?.length ?? 0;
  const centroid = Array.from({ length: dims }, () => 0);
  for (const vector of vectors) {
    for (const [d, value] of vector.entries()) {
      centroid[d] = (centroid[d] ?? 0) + value / vectors.length;
    }
  }
  return centroid;
}

/**
 * Group answers by similarity to each group's seed (the first ungrouped item, in
 * participant order). Seed-based rather than transitive single-linkage so the
 * grouping is deterministic and free of chaining ambiguity — adequate for the
 * small rosters combine runs and for an informational signal.
 */
function clusterBySeed(items: Item[]): string[][] {
  const clusters: string[][] = [];
  const used = new Set<string>();
  for (const seed of items) {
    if (used.has(seed.id)) {
      continue;
    }
    used.add(seed.id);
    const group = [seed.id];
    for (const other of items) {
      if (
        !used.has(other.id) &&
        cosineSimilarity(seed.vector, other.vector) >= CLUSTER_THRESHOLD
      ) {
        used.add(other.id);
        group.push(other.id);
      }
    }
    clusters.push(group);
  }
  return clusters;
}
