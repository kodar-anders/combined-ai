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
  type CombineEvent,
  type CombineRequest,
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
 * Run the broadcast strategy. `roster` lists the resolved participants. `onEvent`,
 * if given, receives a `response` event as each participant settles. Internal —
 * exposed to consumers only through {@link ProviderRegistry.combine}.
 */
export async function broadcast(
  roster: RosterEntry[],
  request: CombineRequest,
  onEvent?: (event: CombineEvent) => void,
): Promise<BroadcastResult> {
  const emit = makeEmitter(onEvent);

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

  return {
    strategy: "broadcast",
    responses,
    usage: aggregateUsage(outcomeUsage(responses)),
  };
}
