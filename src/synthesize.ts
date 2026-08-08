/**
 * Standalone, single-provider merge of independent text candidates (e.g.
 * `ensemble()`'s `votes[field].candidates`) into one coherent answer via a
 * single LLM call. Not a combine strategy — it takes literal text candidates,
 * not a roster of participants, and makes exactly one provider call. Same
 * tier as `src/embeddings.ts`'s `cosineSimilarity`.
 */

import { letterLabel } from "./label";
import { type RetryOptions } from "./transport";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from "./types";

/**
 * Draft framing (independent from consensus's `SYNTH_FRAMING` — this operates
 * on bare candidate values with no critique round, not full drafted answers).
 * Test-coupling marker: `"Merge them into one coherent"`.
 */
const SYNTHESIZE_FRAMING =
  "You are given several independent answers to the same prompt, produced " +
  "separately with no chance to see each other's work. Merge them into one " +
  "coherent, correct answer. Prefer correctness over popularity: if one " +
  "answer is right and the others are wrong, adopt the correct one rather " +
  "than averaging or splitting the difference; blend points only when they " +
  "are genuinely complementary, not contradictory. If they conflict in a way " +
  "you can't resolve, say so plainly rather than papering over it. Write " +
  "ONLY the merged answer, as if answering for the first time. Do not " +
  "mention or allude to the candidates, this process, or the fact that there " +
  'are multiple answers, and do not use words like "the candidates" or ' +
  'labels like "Answer A"/"Answer B".';

export type SynthesizeTextOptions = {
  model?: string;
  maxTokens?: number;
  /**
   * Forwarded as-is, no validation. Anthropic rejects this parameter on
   * Opus 4.7+/Sonnet 5/Fable 5 (including the library default) — a 400 with
   * no fallback, since `synthesizeText` makes exactly one call to one
   * provider (unlike consensus, where a rejected participant just drops out).
   */
  temperature?: number;
  signal?: AbortSignal;
  retry?: RetryOptions;
  timeoutMs?: number;
};

/** Render candidates as `### Answer A\n<text>` blocks, lettered in input order. */
function renderCandidates(candidates: string[]): string {
  return candidates
    .map((text, i) => `### Answer ${letterLabel(i)}\n${text}`)
    .join("\n\n");
}

/**
 * Merge independent text `candidates` (answers to the same `prompt`) into one
 * coherent string via a single `provider.complete()` call. Blank/whitespace-only
 * candidates are filtered first; fewer than 2 non-blank candidates throws (a
 * plain `Error` — no provider call has happened yet, so there's no
 * `status`/`kind`/`cause` to attach).
 *
 * Returns the raw {@link CompletionResult} (not a new wrapper type), so
 * `costOf(result)` / `costOfUsage(result.usage, result.model)` work with zero
 * new plumbing. A rejected `provider.complete()` call propagates unchanged.
 */
export async function synthesizeText(
  provider: Provider,
  prompt: string,
  candidates: string[],
  options?: SynthesizeTextOptions,
): Promise<CompletionResult> {
  const nonBlank = candidates.filter((c) => c.trim() !== "");
  if (nonBlank.length < 2) {
    throw new Error(
      `synthesizeText requires at least 2 non-blank candidates, got ${String(nonBlank.length)}`,
    );
  }

  const body = `## Prompt\n${prompt}\n\n## Candidate answers\n${renderCandidates(nonBlank)}`;
  const request: CompletionRequest = {
    system: SYNTHESIZE_FRAMING,
    messages: [{ role: "user", content: body }],
  };
  if (options?.model !== undefined) {
    request.model = options.model;
  }
  if (options?.maxTokens !== undefined) {
    request.maxTokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    request.temperature = options.temperature;
  }
  if (options?.signal !== undefined) {
    request.signal = options.signal;
  }
  if (options?.retry !== undefined) {
    request.retry = options.retry;
  }
  if (options?.timeoutMs !== undefined) {
    request.timeoutMs = options.timeoutMs;
  }

  return provider.complete(request);
}
