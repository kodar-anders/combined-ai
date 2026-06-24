/**
 * Vector helpers for working with embeddings. Pure and dependency-free — no API
 * calls (the embedding *calls* live on the providers, reached via
 * {@link ProviderRegistry.embed}/`embedMany`). Kept separate from that plumbing,
 * mirroring the `cost.ts` / `models.ts` data-vs-math split.
 */

/**
 * Cosine similarity of two equal-length vectors: their dot product over the
 * product of their magnitudes, in `[-1, 1]` (higher = more similar in
 * direction).
 *
 * Always compare embeddings with this — **never a raw dot product**: some
 * providers return non-unit-length vectors (e.g. dimension-reduced OpenAI
 * embeddings), and only cosine normalizes for magnitude. Comparing vectors from
 * different models or dimensions is meaningless, so a length mismatch throws
 * rather than silently returning a number. A zero vector has no direction, so a
 * similarity involving one is `0` (not `NaN`).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity requires equal-length vectors; got ${String(a.length)} and ${String(b.length)}.`,
    );
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [i, ai] of a.entries()) {
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
