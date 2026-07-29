/**
 * The **broadcast** combine strategy: fan one prompt out to every participant in
 * parallel and return *all* of their raw answers — no cooperation, no critique,
 * no synthesis, no vote. This is the simplest strategy: where consensus/pipeline/
 * ensemble combine the participants' work into one answer, broadcast deliberately
 * does not combine at all. Use it to compare models side by side, or to drive your
 * own selection/UI over the raw outputs.
 *
 * Each participant answers the user's prompt *verbatim* (no shaped framing — the
 * point is the unmodified per-model answer). Builds only on the {@link Provider}
 * contract (`complete()`), so it needs no provider-specific code and is
 * unit-testable with fake providers. Structured output is out of scope (the
 * registry rejects `responseFormat` for this strategy), as is any merge.
 */

import {
  type BroadcastResult,
  type CombineOptions,
  type CombineRequest,
} from "./index";
import { compareAnswers, type ResolvedEmbedder } from "./embedding";
import {
  aggregateUsage,
  makeEmitter,
  noResultError,
  outcomeUsage,
  respondAll,
  type RosterEntry,
  runEmbedding,
} from "./shared";

/**
 * Run the broadcast strategy. `roster` lists the resolved participants. `onEvent`,
 * if given, receives a `response` event as each participant settles. Internal —
 * exposed to consumers only through {@link ProviderRegistry.combine}.
 */
export async function broadcast(
  roster: RosterEntry[],
  request: CombineRequest,
  options?: CombineOptions,
  embedder?: ResolvedEmbedder,
): Promise<BroadcastResult> {
  const emit = makeEmitter(options?.onEvent);
  // `options.budget` is accepted for a uniform API but inert here: a single
  // parallel fan-out has no later phase to gate, so there is nothing to pre-empt.
  // Price the run after the fact with `combineCost(result)` instead.

  // Every participant answers the same prompt, verbatim, in parallel.
  const responses = await respondAll(roster, request, emit);

  // Broadcast returns whatever each model gave back, so a successful call counts
  // even if its text is empty — unlike consensus/pipeline, which drop empty
  // answers because an empty draft can't advance or satisfy minParticipants.
  // Only an all-failed run has nothing to return.
  if (!responses.some((o) => o.status === "ok")) {
    throw noResultError(
      "Broadcast failed: no participant returned a response.",
      responses,
    );
  }

  // Optional semantic comparison: embed the non-empty answers with the designated
  // model and attach an agreement/outlier signal. Informational — the raw responses
  // are returned unchanged regardless — so a failure is reported (`embeddingError` +
  // an `embedding` event via runEmbedding) rather than fatal.
  const usageEntries = outcomeUsage(responses);
  const embedded =
    embedder === undefined
      ? {}
      : await runEmbedding(() => {
          const answers = responses.flatMap((o) =>
            o.status === "ok" && o.result.text.trim() !== ""
              ? [{ id: o.id, text: o.result.text }]
              : [],
          );
          return compareAnswers(embedder, answers, request.signal);
        }, emit);
  if (embedded.value !== undefined) {
    usageEntries.push(embedded.value.usage);
  }

  return {
    strategy: "broadcast",
    responses,
    ...(embedded.value === undefined
      ? {}
      : { semantic: embedded.value.comparison }),
    ...(embedded.embeddingError === undefined
      ? {}
      : { embeddingError: embedded.embeddingError }),
    usage: aggregateUsage(usageEntries),
  };
}
