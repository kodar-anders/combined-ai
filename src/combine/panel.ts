/**
 * The **panel** combine strategy: a role-based panel (a.k.a. mixture-of-agents /
 * "society of minds"). Every participant answers the *same* prompt through its own
 * {@link ParticipantSpec.instruction} (a role/persona), so the diversity comes from
 * the prompt rather than the model — letting the same provider+model appear several
 * times as different experts. One designated participant then **integrates** the
 * complementary perspectives into a single answer.
 *
 * This is deliberately distinct from {@link consensus}: consensus *adjudicates* for
 * a single correct answer (its synth framing prefers correctness over popularity),
 * whereas panel *integrates* complementary contributions and preserves each one.
 * That framing difference is the whole reason it's a separate strategy.
 *
 * Builds only on the provider-agnostic {@link Provider} contract — each phase is a
 * `complete()` call with a shaped `system` + message — so it needs no
 * provider-specific code and is trivially unit-testable with fake providers.
 */

import {
  type CombineOptions,
  type CombineRequest,
  type PanelResult,
  type ParticipantOutcome,
} from "./index";
import { compareAnswers, type ResolvedEmbedder } from "./embedding";
import {
  aggregateUsage,
  composeSystem,
  completionFor,
  makeBudget,
  makeEmitter,
  noResultError,
  outcomeUsage,
  renderConversation,
  type RosterEntry,
  runOutcome,
  sanitizeAnswer,
  type UsageEntry,
} from "./shared";
import { type CompletionResult, type SystemPrompt } from "../types";

/**
 * The answer phase: each participant answers in character. Kept
 * reasoning-shaped (not user-shaped) because the output feeds an integrator that
 * needs the "why" to combine it, not an end user. The marker `member of an expert
 * panel` classifies this phase in the tests — keep it out of the other framings.
 */
const PANEL_ANSWER_FRAMING =
  "You are one member of an expert panel answering the user's question from your " +
  "assigned perspective. Give the most complete, correct answer your perspective " +
  "can contribute; include your reasoning, assumptions, and caveats. Your reply is " +
  "read by an integrator, not the end user, who will combine it with the other " +
  "panelists' answers — so favor complete substance over stylistic brevity, and " +
  "skip greetings, sign-offs, and preamble.";

/**
 * The optional review phase: each panelist cross-examines the answers through its
 * own role lens. Distinct from consensus's critique (which hunts for the single
 * best answer) — here the point is to surface conflicts and gaps across
 * complementary views. Marker `produce only a review` (kept distinct from
 * consensus's `produce only a critique`).
 */
const PANEL_REVIEW_FRAMING =
  "You are serving on an expert panel. Below are the panelists' answers to the " +
  "user's question. Review them from your perspective: point out conflicts, gaps, " +
  "risks, and errors, and note where their claims are sound. Judge each on its " +
  "merits regardless of who wrote it, including any you may have written yourself; " +
  "refer to answers by their heading. Do not rewrite their work and do not write " +
  "the final answer — produce only a review.";

/**
 * The synthesis phase — the load-bearing framing that makes panel a *panel*.
 * **Invariant (preserve):** it *integrates* complementary perspectives (preserve
 * each distinct contribution; resolve or surface conflicts rather than dropping a
 * view) rather than adjudicating for one winner like consensus's `SYNTH_FRAMING`,
 * and it forbids alluding to the panel/perspectives/process — including **naming
 * or attributing the individual roles** in the answer, since the input answers are
 * fed with attributed role headings (renderAnswers) that must not leak through. The
 * synthesizer runs *without* any role instruction — it is a neutral integrator, not
 * one of the roles. Marker `integrate the complementary perspectives` (kept distinct
 * from consensus's `lead assistant`).
 */
const PANEL_SYNTH_FRAMING =
  "You are the integrator writing the final answer to the user's question below. " +
  "You are given several expert answers from different perspectives, plus any " +
  "reviews of them, as private input material — the user has not seen any of it " +
  "and must not learn it exists. Your job is to integrate the complementary " +
  "perspectives into one answer: preserve each perspective's distinct, correct " +
  "contribution; where they conflict, resolve it on the merits or surface the " +
  "trade-off rather than dropping a view; do not merely pick one answer and " +
  "discard the rest. Judge every contribution on its merits regardless of source. " +
  "Write ONLY the answer itself, addressed to the user as if answering for the " +
  "first time. Do not mention or allude to this material, the panel, the " +
  "perspectives, the reviews, or the integration process; do not name or " +
  "attribute the individual roles or panelists in the answer (the headings below " +
  'are for your reference only — never write things like "the architect ' +
  'recommends" or "as one reviewer noted"); and do not use labels like ' +
  '"Answer A"/"Answer B".';

/** A participant whose answer succeeded, kept with its roster entry for later phases. */
type Survivor = RosterEntry & {
  result: CompletionResult;
};

/**
 * Run the panel strategy. `roster` lists the resolved participants; `synthesizer`
 * names which of them integrates the final answer (it falls back to other
 * survivors if that one is unavailable). `onEvent`, if given, receives progress
 * events. Internal — exposed to consumers only through
 * {@link ProviderRegistry.combine}.
 */
export async function panel(
  roster: RosterEntry[],
  synthesizer: string,
  request: CombineRequest,
  options?: CombineOptions,
  embedder?: ResolvedEmbedder,
): Promise<PanelResult> {
  const emit = makeEmitter(options?.onEvent);
  const budget = makeBudget(options?.budget, emit);

  // ── Phase 1: answers (parallel fan-out, each in character) ──
  emit({ type: "phase", phase: "answering" });
  const answerResults = await Promise.all(
    roster.map(async (entry) => {
      const system = roleSystem(
        request.system,
        entry.instruction,
        PANEL_ANSWER_FRAMING,
      );
      const outcome = await runOutcome(entry.id, entry.providerName, () =>
        entry.provider.complete(
          completionFor(request, system, request.messages, entry),
        ),
      );
      emit({
        type: "answer",
        id: entry.id,
        provider: entry.providerName,
        status: outcome.status,
      });
      return { entry, outcome };
    }),
  );
  const answers: ParticipantOutcome[] = answerResults.map((a) => a.outcome);
  // Price the answers toward the budget; the review/sanitize phases below check it.
  budget.add(outcomeUsage(answers));

  // Keep only answers that succeeded AND produced non-empty text (an empty answer
  // can't contribute a perspective and would render as a blank heading).
  const survivors: Survivor[] = answerResults.flatMap((a) =>
    a.outcome.status === "ok" && a.outcome.result.text.trim() !== ""
      ? [{ ...a.entry, result: a.outcome.result }]
      : [],
  );

  const [firstSurvivor] = survivors;
  if (firstSurvivor === undefined) {
    throw noResultError(
      "Panel failed: no participant produced an answer.",
      answers,
    );
  }
  // Only one perspective survived — there is nothing to integrate. Return that
  // answer, but sanitize it first: unlike a consensus draft, a panel answer was
  // written in character and addressed to an integrator, so its raw text may be
  // role-scoped or meta-referential rather than a clean reply to the user. (Panel
  // has no `minParticipants`, so this `=== 1` check is the only guard here.)
  if (survivors.length === 1) {
    let finalText = firstSurvivor.result.text;
    let sanitizeEntry: UsageEntry = { id: firstSurvivor.id };
    if (!budget.gate("sanitize")) {
      const sanitized = await sanitizeAnswer(
        firstSurvivor.provider,
        request,
        firstSurvivor.result.text,
        firstSurvivor,
      );
      finalText = sanitized.text;
      sanitizeEntry = {
        id: firstSurvivor.id,
        model: sanitized.model,
        usage: sanitized.usage,
      };
    }
    return {
      text: finalText,
      strategy: "panel",
      synthesizer: firstSurvivor.id,
      model: firstSurvivor.result.model,
      answers,
      reviews: [],
      usage: aggregateUsage([...outcomeUsage(answers), sanitizeEntry]),
    };
  }

  // Optional, informational: embed the surviving answers to score their semantic
  // agreement (and flag the outlier). Kicked off here — after the early returns —
  // so it overlaps the review + synthesis phases; awaited only when building the
  // result. It never feeds synthesis, and a failure resolves to undefined so it
  // can't break the run. For a panel, *low* agreement is expected/healthy.
  const perspectivePromise =
    embedder === undefined
      ? undefined
      : compareAnswers(
          embedder,
          survivors.map((s) => ({ id: s.id, text: s.result.text })),
          request.signal,
          // eslint-disable-next-line unicorn/no-useless-undefined, unicorn/prefer-await -- a rejected comparison resolves to `undefined` (informational, must not break the run); the promise runs concurrently with review/synth, so awaiting it here would serialize it.
        ).catch(() => undefined);

  const question = renderConversation(request.messages);
  const answersBody = `## Question\n${question}\n\n## Panel answers\n${renderAnswers(survivors)}`;

  // ── Phase 2: reviews (optional cross-examination, parallel over survivors) ──
  // Opt-in via `crossExamine`, and skipped if the budget is already spent (a
  // parallel fan-out can't be gated mid-flight, only before it launches).
  let reviews: ParticipantOutcome[] = [];
  if (request.crossExamine === true && !budget.gate("reviews")) {
    emit({ type: "phase", phase: "reviewing" });
    reviews = await Promise.all(
      survivors.map(async (s) => {
        const system = roleSystem(
          request.system,
          s.instruction,
          PANEL_REVIEW_FRAMING,
        );
        const outcome = await runOutcome(s.id, s.providerName, () =>
          s.provider.complete(
            completionFor(
              request,
              system,
              [{ role: "user", content: answersBody }],
              s,
            ),
          ),
        );
        emit({
          type: "review",
          id: s.id,
          provider: s.providerName,
          status: outcome.status,
        });
        return outcome;
      }),
    );
    budget.add(outcomeUsage(reviews));
  }

  // ── Phase 3: synthesis (single call, one fallback hop per remaining survivor) ──
  emit({ type: "phase", phase: "synthesizing" });
  const reviewsRendered = renderReviews(reviews);
  const reviewsBlock =
    reviewsRendered === "" ? "" : `\n\n## Reviews\n${reviewsRendered}`;
  const synthBody = `${answersBody}${reviewsBlock}`;
  // The integrator runs neutrally — no role instruction (see PANEL_SYNTH_FRAMING).
  const synthSystem = composeSystem(request.system, PANEL_SYNTH_FRAMING);

  let lastError: Error | undefined;
  // Usage from synthesis attempts that were billed but discarded (an empty
  // synthesis that fell back to the next survivor) — counted so the reported cost
  // reflects every call made, not just the winning one.
  const synthUsage: UsageEntry[] = [];
  for (const candidate of synthesizerOrder(survivors, synthesizer)) {
    try {
      const result = await candidate.provider.complete(
        completionFor(
          request,
          synthSystem,
          [{ role: "user", content: synthBody }],
          candidate,
        ),
      );
      const synthEntry: UsageEntry = {
        id: candidate.id,
        model: result.model,
        usage: result.usage,
      };
      synthUsage.push(synthEntry);
      budget.add([synthEntry]);
      // A resolved-but-empty synthesis is treated as a failure so the next
      // survivor is tried.
      if (result.text.trim() === "") {
        lastError = new Error(`${candidate.id} produced an empty synthesis`);
        continue;
      }
      // Strip any process narration the synthesis framing failed to suppress.
      // Skipped (answer kept as-is) when the budget is spent — optional polish.
      let finalText = result.text;
      if (!budget.gate("sanitize")) {
        const sanitized = await sanitizeAnswer(
          candidate.provider,
          request,
          result.text,
          candidate,
        );
        synthUsage.push({
          id: candidate.id,
          model: sanitized.model,
          usage: sanitized.usage,
        });
        finalText = sanitized.text;
      }
      // Settle the (concurrent) perspective-agreement embedding before returning.
      const perspective = await perspectivePromise;
      return {
        text: finalText,
        strategy: "panel",
        synthesizer: candidate.id,
        model: result.model,
        answers,
        reviews,
        ...(perspective
          ? { perspectiveAgreement: perspective.comparison }
          : {}),
        usage: aggregateUsage([
          ...outcomeUsage(answers),
          ...outcomeUsage(reviews),
          ...synthUsage,
          ...(perspective ? [perspective.usage] : []),
        ]),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `Panel synthesis failed for all participants: ${lastError?.message ?? "unknown error"}`,
  );
}

/**
 * Compose a participant's phase system prompt in the order
 * `[request.system] + [instruction] + [phase framing]` (context → identity →
 * task), reusing the public {@link composeSystem}. With no instruction it's just
 * the caller's system + the framing.
 */
function roleSystem(
  userSystem: string | SystemPrompt | undefined,
  instruction: string | undefined,
  framing: string,
): string {
  const base =
    instruction === undefined
      ? userSystem
      : composeSystem(userSystem, instruction);
  return composeSystem(base, framing);
}

/** The requested synthesizer first (if it survived), then the other survivors as fallbacks. */
function synthesizerOrder(
  survivors: Survivor[],
  synthesizer: string,
): Survivor[] {
  const requested = survivors.find((s) => s.id === synthesizer);
  const rest = survivors.filter((s) => s !== requested);
  return requested ? [requested, ...rest] : rest;
}

/** Render the surviving answers, always attributed by role id (the roles are the point). */
function renderAnswers(survivors: Survivor[]): string {
  return survivors.map((s) => `### ${s.id}\n${s.result.text}`).join("\n\n");
}

/** Render the successful reviews, attributed by role id (failed reviews are skipped). */
function renderReviews(reviews: ParticipantOutcome[]): string {
  const blocks: string[] = [];
  for (const review of reviews) {
    if (review.status !== "ok") {
      continue;
    }
    blocks.push(`### Review from ${review.id}\n${review.result.text}`);
  }
  return blocks.join("\n\n");
}
