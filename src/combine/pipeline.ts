/**
 * The **pipeline** combine strategy: a conveyor belt of providers that refine
 * one answer in sequence. The first participant writes an initial answer; each
 * later participant receives the question plus the current running answer and
 * improves it; the last stage to produce an answer wins.
 *
 * Builds only on the provider-agnostic {@link Provider} contract — each stage is
 * a `complete()` call with a shaped `system` + message — so it needs no
 * provider-specific code and is trivially unit-testable with fake providers.
 *
 * Unlike consensus there is no separate synthesizer and no critique round, so a
 * weak refiner's regression is permanent; the refine framing therefore treats
 * the current answer as a strong baseline to preserve. `synthesizer`,
 * `attribution`, and `minParticipants` from the request are consensus-specific
 * and ignored here.
 */

import {
  type CombineEvent,
  type CombineRequest,
  type ParticipantOutcome,
  type PipelineResult,
} from "./index";
import {
  aggregateUsage,
  composeSystem,
  completionFor,
  makeEmitter,
  outcomeUsage,
  renderConversation,
  type RosterEntry,
  runOutcome,
  sanitizeAnswer,
} from "./shared";

/**
 * The first stage has no prior answer to build on, so it just writes the best
 * standalone answer. Kept answer-shaped (not reasoning-shaped) because its output
 * is fed to the next stage as the answer to improve, not as notes to critique.
 */
const PIPELINE_FIRST_FRAMING =
  "You are the first stage in a pipeline of AI assistants answering the user's " +
  "question below. Write the best, most complete and correct answer you can. " +
  "Output only the answer itself, addressed to the user — no preamble and no " +
  "notes about your process.";

/**
 * Refining stages see the question and the current answer. The preservation /
 * ratchet wording is deliberate: there is no downstream synthesizer to catch a
 * regression, so a refiner must improve the answer or leave it alone, never
 * rewrite it worse. The "do not mention the earlier answer" clause keeps process
 * narration out of what is ultimately the user-facing answer.
 */
const PIPELINE_REFINE_FRAMING =
  "You are one stage in a pipeline of AI assistants improving an answer to the " +
  "user's question. Below are the question and the current answer from an " +
  "earlier stage. Treat the current answer as a strong baseline: revise the " +
  "current answer only to improve its correctness and completeness — fix errors, " +
  "fill genuine gaps, and sharpen unclear wording. Preserve everything that is " +
  "already correct and keep its substance and length; do not drop correct " +
  "content or rewrite it merely to sound different. If you cannot improve it, " +
  "return it unchanged. Output only the improved answer, addressed to the user " +
  "as if answering for the first time — do not mention the earlier answer, the " +
  "revision, or that multiple assistants were involved.";

/** The running answer carried from one stage to the next (its producing stage + its output). */
type Running = {
  /** The roster entry (id/provider/overrides) of the stage that produced this answer. */
  entry: RosterEntry;
  text: string;
  /** The model that actually produced this answer (the stage's `result.model`). */
  model: string;
  /**
   * Whether this answer may carry process narration and so needs the sanitizing
   * pass: true once a refining stage actually rewrote the text. A first-stage
   * answer (no prior context) and a verbatim passthrough (a refiner that left
   * the text unchanged) inherit the provenance of what they built on.
   */
  needsSanitize: boolean;
};

/**
 * Run the pipeline strategy. `roster` lists the resolved participants in
 * conveyor order. `onEvent`, if given, receives a `stage` event as each stage
 * settles. Internal — exposed to consumers only through
 * {@link ProviderRegistry.combine}.
 */
export async function pipeline(
  roster: RosterEntry[],
  request: CombineRequest,
  onEvent?: (event: CombineEvent) => void,
): Promise<PipelineResult> {
  const emit = makeEmitter(onEvent);

  const question = renderConversation(request.messages);
  const firstSystem = composeSystem(request.system, PIPELINE_FIRST_FRAMING);
  const refineSystem = composeSystem(request.system, PIPELINE_REFINE_FRAMING);

  const stages: ParticipantOutcome[] = [];
  let current: Running | undefined;

  for (const [index, entry] of roster.entries()) {
    // The first stage that has a running answer to build on refines; a leading
    // run of failed stages each start fresh until one produces an answer.
    const completion =
      current === undefined
        ? completionFor(request, firstSystem, request.messages, entry)
        : completionFor(
            request,
            refineSystem,
            [
              {
                role: "user",
                content: `## Question\n${question}\n\n## Current answer\n${current.text}`,
              },
            ],
            entry,
          );

    const outcome = await runOutcome(entry.id, entry.providerName, () =>
      entry.provider.complete(completion),
    );
    stages.push(outcome);
    emit({
      type: "stage",
      id: entry.id,
      provider: entry.providerName,
      status: outcome.status,
      index,
    });

    // A stage advances the running answer only if it produced non-empty text;
    // otherwise the previous answer carries forward unchanged.
    if (outcome.status === "ok" && outcome.result.text.trim() !== "") {
      const text = outcome.result.text;
      // A refining stage that actually changed the text may have narrated the
      // revision; a verbatim passthrough (or the first stage) inherits the
      // sanitize-need of the answer it built on, so a no-op refiner doesn't
      // trigger a wasted sanitizing call. `current` here is still the prior answer.
      const needsSanitize =
        current !== undefined &&
        (text !== current.text || current.needsSanitize);
      current = { entry, text, model: outcome.result.model, needsSanitize };
    }
  }

  if (current === undefined) {
    throw new Error("Pipeline failed: no participant produced an answer.");
  }

  // Strip any process narration a refining stage may have leaked. Skipped when
  // the answer needs no sanitizing (a lone first-stage answer, or an unchanged
  // passthrough), so the extra model call only runs when it can matter.
  const sanitized = current.needsSanitize
    ? await sanitizeAnswer(
        current.entry.provider,
        request,
        current.text,
        current.entry,
      )
    : { text: current.text };

  return {
    text: sanitized.text,
    strategy: "pipeline",
    finalParticipant: current.entry.id,
    model: current.model,
    stages,
    usage: aggregateUsage([
      ...outcomeUsage(stages),
      { id: current.entry.id, usage: sanitized.usage },
    ]),
  };
}
