/**
 * The **consensus** combine strategy: every participant drafts an answer in
 * parallel, then every participant critiques all drafts, then one designated
 * participant synthesizes the final answer.
 *
 * Builds only on the provider-agnostic {@link Provider} contract — each phase is
 * a `complete()` call with a shaped `system` + message — so it needs no
 * provider-specific code and is trivially unit-testable with fake providers.
 */

import {
  type CombineEvent,
  type CombineRequest,
  type ConsensusResult,
  type ParticipantOutcome,
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
  type UsageEntry,
} from "./shared";
import { type CompletionResult } from "../types";

/**
 * Prepended to the draft and critique phases — the messages that travel from one
 * AI to another. It strips ceremony (greetings/sign-offs/preamble) to save
 * tokens but deliberately KEEPS reasoning: those phases feed other AIs that need
 * the "why" to critique it, not an end user. The user-facing synthesis omits this.
 */
const CONCISE_DIRECTIVE =
  "Skip greetings, sign-offs, and preamble — begin directly with the content. " +
  "Include your reasoning, assumptions, and any caveats; your reply is read by " +
  "other AI assistants, not an end user, so favor complete substance over " +
  "brevity of style.";

const CRITIQUE_FRAMING =
  "You are one of several AI assistants that independently answered the same " +
  "question. Below are all the drafts. Critically evaluate them: " +
  "point out errors, gaps, and risks in each, and scrutinize the reasoning, " +
  "not just the conclusions. Judge every answer on its merits regardless of " +
  "which assistant wrote it, including any you may have written yourself; refer " +
  "to answers by their heading. Do not write the final answer yet — produce " +
  "only a critique, then end with exactly three lines:\n" +
  "BEST: <heading of the strongest answer>\n" +
  "KEY FIX: <the single most important improvement to it>\n" +
  "CONFIDENCE: <low | medium | high>";

const SYNTH_FRAMING =
  "You are the lead assistant writing the final answer to the user's question " +
  "below. You are given several draft answers from other assistants, plus their " +
  "critiques (each ending with that critic's pick and most important fix), as " +
  "private input material — the user has not seen any of it and must not learn " +
  "it exists. Use it to produce the most correct answer. Prefer correctness " +
  "over popularity: a single correct draft beats a wrong majority, so adopt it " +
  "and do not average conflicting claims; blend points only when they are " +
  "genuinely complementary, not contradictory; if the material is inconclusive, " +
  "say so plainly rather than papering over it. Judge every draft on its merits " +
  "regardless of source — one may be your own, which you must not favor. Write " +
  "ONLY the answer itself, addressed to the user as if answering for the first " +
  "time. Do not mention or allude to this material, the other assistants, the " +
  "drafting or critique process, or the existence of multiple answers, and do " +
  'not use words like "candidates", "the drafts", or "the options" or labels ' +
  'like "Answer A"/"Answer B".';

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A participant whose draft succeeded, kept with its roster entry for later phases. */
type Survivor = RosterEntry & {
  result: CompletionResult;
};

/**
 * Run the consensus strategy. `roster` lists the resolved participants;
 * `synthesizer` names which of them writes the final answer (it falls back to
 * other survivors if that one is unavailable). `onEvent`, if given, receives
 * progress events. Internal — exposed to consumers only through
 * {@link ProviderRegistry.combine}.
 */
export async function consensus(
  roster: RosterEntry[],
  synthesizer: string,
  request: CombineRequest,
  onEvent?: (event: CombineEvent) => void,
): Promise<ConsensusResult> {
  const anonymized = (request.attribution ?? "anonymized") === "anonymized";
  const minParticipants = request.minParticipants ?? 2;
  const emit = makeEmitter(onEvent);

  // ── Phase 1: drafts (parallel fan-out) ──
  emit({ type: "phase", phase: "drafting" });
  const draftSystem = composeSystem(request.system, CONCISE_DIRECTIVE);
  const draftResults = await Promise.all(
    roster.map(async (entry) => {
      const outcome = await runOutcome(entry.id, entry.providerName, () =>
        entry.provider.complete(
          completionFor(request, draftSystem, request.messages, entry),
        ),
      );
      emit({
        type: "draft",
        id: entry.id,
        provider: entry.providerName,
        status: outcome.status,
      });
      return { entry, outcome };
    }),
  );
  const drafts: ParticipantOutcome[] = draftResults.map((d) => d.outcome);

  // Keep only drafts that succeeded AND produced non-empty text: an empty draft
  // (e.g. Gemini spending its whole budget on thinking) would otherwise count
  // toward minParticipants and render as a blank `### Answer A` into the critique
  // prompts — wasted tokens and degraded consensus. Mirrors the synthesis guard.
  const survivors: Survivor[] = draftResults.flatMap((d) =>
    d.outcome.status === "ok" && d.outcome.result.text.trim() !== ""
      ? [{ ...d.entry, result: d.outcome.result }]
      : [],
  );

  const [firstSurvivor] = survivors;
  if (firstSurvivor === undefined) {
    throw new Error("Consensus failed: no participant produced a draft.");
  }
  // A single-provider combine is just that provider answering.
  if (roster.length === 1) {
    return {
      text: firstSurvivor.result.text,
      strategy: "consensus",
      synthesizer: firstSurvivor.id,
      model: firstSurvivor.result.model,
      drafts,
      critiques: [],
      usage: aggregateUsage(outcomeUsage(drafts)),
    };
  }
  if (survivors.length < minParticipants) {
    throw new Error(
      `Consensus failed: only ${String(survivors.length)} of ` +
        `${String(roster.length)} participants produced a draft ` +
        `(minimum ${String(minParticipants)}).`,
    );
  }

  // ── Phase 2: critiques (parallel fan-out over survivors) ──
  emit({ type: "phase", phase: "critiquing" });
  const answersBlock = renderAnswers(survivors, anonymized);
  const question = renderConversation(request.messages);
  const critiqueBody = `## Original question\n${question}\n\n## Drafts\n${answersBlock}`;
  const critiqueSystem = composeSystem(
    request.system,
    `${CONCISE_DIRECTIVE}\n\n${CRITIQUE_FRAMING}`,
  );
  const critiques: ParticipantOutcome[] = await Promise.all(
    survivors.map(async (s) => {
      const outcome = await runOutcome(s.id, s.providerName, () =>
        s.provider.complete(
          completionFor(
            request,
            critiqueSystem,
            [{ role: "user", content: critiqueBody }],
            s,
          ),
        ),
      );
      emit({
        type: "critique",
        id: s.id,
        provider: s.providerName,
        status: outcome.status,
      });
      return outcome;
    }),
  );
  // ── Phase 3: synthesis (single call, one fallback hop per remaining survivor) ──
  emit({ type: "phase", phase: "synthesizing" });
  const critiquesRendered = renderCritiques(critiques, anonymized);
  const critiquesBlock =
    critiquesRendered === "" ? "" : `\n\n## Critiques\n${critiquesRendered}`;
  const synthBody = `${critiqueBody}${critiquesBlock}`;
  const synthSystem = composeSystem(request.system, SYNTH_FRAMING);

  let lastError: Error | undefined;
  // Usage from synthesis attempts that were billed but discarded (an empty
  // synthesis that fell back to the next survivor) — counted so the reported
  // cost reflects every call made, not just the winning one.
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
      synthUsage.push({ id: candidate.id, usage: result.usage });
      // A resolved-but-empty synthesis (e.g. Gemini consuming the whole token
      // budget on thinking) is treated as a failure so the next survivor is tried.
      if (result.text.trim() === "") {
        lastError = new Error(`${candidate.id} produced an empty synthesis`);
        continue;
      }
      // Second pass strips any process narration the synthesis framing
      // failed to suppress (e.g. "synthesizes the drafts", "Answer A").
      const sanitized = await sanitizeAnswer(
        candidate.provider,
        request,
        result.text,
        candidate,
      );
      synthUsage.push({ id: candidate.id, usage: sanitized.usage });
      return {
        text: sanitized.text,
        strategy: "consensus",
        synthesizer: candidate.id,
        model: result.model,
        drafts,
        critiques,
        usage: aggregateUsage([
          ...outcomeUsage(drafts),
          ...outcomeUsage(critiques),
          ...synthUsage,
        ]),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `Consensus synthesis failed for all participants: ${lastError?.message ?? "unknown error"}`,
  );
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

function renderAnswers(survivors: Survivor[], anonymized: boolean): string {
  return survivors
    .map((s, i) => {
      const label = anonymized
        ? `Answer ${LETTERS[i] ?? `#${String(i + 1)}`}`
        : `Answer from ${s.id}`;
      return `### ${label}\n${s.result.text}`;
    })
    .join("\n\n");
}

/**
 * Render critiques, labelled by each critic's position in the survivor order so
 * the letters line up with {@link renderAnswers} even when some critiques
 * failed (a failed critique is skipped, not re-lettered).
 */
function renderCritiques(
  critiques: ParticipantOutcome[],
  anonymized: boolean,
): string {
  const blocks: string[] = [];
  for (const [i, critique] of critiques.entries()) {
    if (critique.status !== "ok") {
      continue;
    }
    const label = anonymized
      ? `Critique ${LETTERS[i] ?? `#${String(i + 1)}`}`
      : `Critique from ${critique.id}`;
    blocks.push(`### ${label}\n${critique.result.text}`);
  }
  return blocks.join("\n\n");
}
