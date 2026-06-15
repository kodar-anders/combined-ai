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
  type CombineResult,
  type ParticipantOutcome,
} from "./index";
import { type ProviderName } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type Message,
  type Provider,
} from "../types";

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

/**
 * Second pass over the synthesized answer. Prompt instructions in the synthesis
 * step alone don't reliably stop the synthesizer from narrating the process
 * ("synthesizes the drafts", "among the candidates", "Answer A"), so this rewrite
 * strips that meta-commentary. It sees only the answer text — never the drafts or
 * the fact that there were several — so it has nothing to narrate.
 */
const SANITIZE_FRAMING =
  "Rewrite the following answer so it reads as a single, self-contained reply " +
  "addressed directly to the user. Remove any meta-commentary about how it was " +
  "produced — any reference to other answers, drafts, candidates, sources, " +
  'reviewers, or a synthesis or selection process (for example "this answer ' +
  'synthesizes the drafts", "among the candidates", or "Answer A"). Preserve the ' +
  "substance, wording, and length as much as possible; change only what is " +
  "needed. Output only the rewritten answer, with no preamble.";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A participant, kept with its resolved provider for the orchestration phases. */
type RosterEntry = { name: ProviderName; provider: Provider };

/** A participant whose draft succeeded, kept with its provider instance for later phases. */
type Survivor = {
  provider: Provider;
  name: ProviderName;
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
  synthesizer: ProviderName,
  request: CombineRequest,
  onEvent?: (event: CombineEvent) => void,
): Promise<CombineResult> {
  const anonymized = (request.attribution ?? "anonymized") === "anonymized";
  const minParticipants = request.minParticipants ?? 2;
  const emit = (event: CombineEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // A progress listener must not break the run.
    }
  };

  // ── Phase 1: drafts (parallel fan-out) ──
  emit({ type: "phase", phase: "drafting" });
  const draftSystem = composeSystem(request.system, CONCISE_DIRECTIVE);
  const draftResults = await Promise.all(
    roster.map(async (entry) => {
      const outcome = await runOutcome(entry.name, () =>
        entry.provider.complete(
          completionFor(request, draftSystem, request.messages),
        ),
      );
      emit({ type: "draft", provider: entry.name, status: outcome.status });
      return { ...entry, outcome };
    }),
  );
  const drafts: ParticipantOutcome[] = draftResults.map((d) => d.outcome);

  const survivors: Survivor[] = draftResults.flatMap((d) =>
    d.outcome.status === "ok"
      ? [{ provider: d.provider, name: d.name, result: d.outcome.result }]
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
      synthesizer: firstSurvivor.name,
      model: firstSurvivor.result.model,
      drafts,
      critiques: [],
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
      const outcome = await runOutcome(s.name, () =>
        s.provider.complete(
          completionFor(request, critiqueSystem, [
            { role: "user", content: critiqueBody },
          ]),
        ),
      );
      emit({ type: "critique", provider: s.name, status: outcome.status });
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
  for (const candidate of synthesizerOrder(survivors, synthesizer)) {
    try {
      const result = await candidate.provider.complete(
        completionFor(request, synthSystem, [
          { role: "user", content: synthBody },
        ]),
      );
      // A resolved-but-empty synthesis (e.g. Gemini consuming the whole token
      // budget on thinking) is treated as a failure so the next survivor is tried.
      if (result.text.trim() === "") {
        lastError = new Error(`${candidate.name} produced an empty synthesis`);
        continue;
      }
      return {
        // Second pass strips any process narration the synthesis framing
        // failed to suppress (e.g. "synthesizes the drafts", "Answer A").
        text: await sanitizeAnswer(candidate.provider, request, result.text),
        strategy: "consensus",
        synthesizer: candidate.name,
        model: result.model,
        drafts,
        critiques,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `Consensus synthesis failed for all participants: ${lastError?.message ?? "unknown error"}`,
  );
}

/** Build a per-phase completion request, carrying over the caller's model/maxTokens. */
function completionFor(
  request: CombineRequest,
  system: string | undefined,
  messages: Message[],
): CompletionRequest {
  const completion: CompletionRequest = { messages };
  if (system !== undefined) {
    completion.system = system;
  }
  if (request.model !== undefined) {
    completion.model = request.model;
  }
  if (request.maxTokens !== undefined) {
    completion.maxTokens = request.maxTokens;
  }
  return completion;
}

/** Prepend the caller's system prompt (if any) to a phase's framing instruction. */
function composeSystem(
  userSystem: string | undefined,
  framing: string,
): string {
  return userSystem === undefined ? framing : `${userSystem}\n\n${framing}`;
}

/** Run one participant's completion, capturing success or failure as an outcome. */
async function runOutcome(
  provider: ProviderName,
  run: () => Promise<CompletionResult>,
): Promise<ParticipantOutcome> {
  try {
    return { provider, status: "ok", result: await run() };
  } catch (error) {
    return {
      provider,
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Rewrite the synthesized answer to remove process narration (see
 * {@link SANITIZE_FRAMING}). On failure or empty output, returns the original
 * answer unchanged — a working (if slightly leaky) answer beats no answer.
 */
async function sanitizeAnswer(
  provider: Provider,
  request: CombineRequest,
  answer: string,
): Promise<string> {
  try {
    const result = await provider.complete(
      completionFor(request, composeSystem(request.system, SANITIZE_FRAMING), [
        { role: "user", content: answer },
      ]),
    );
    return result.text.trim() === "" ? answer : result.text;
  } catch {
    return answer;
  }
}

/** The requested synthesizer first (if it survived), then the other survivors as fallbacks. */
function synthesizerOrder(
  survivors: Survivor[],
  synthesizer: ProviderName,
): Survivor[] {
  const requested = survivors.find((s) => s.name === synthesizer);
  const rest = survivors.filter((s) => s !== requested);
  return requested ? [requested, ...rest] : rest;
}

function renderAnswers(survivors: Survivor[], anonymized: boolean): string {
  return survivors
    .map((s, i) => {
      const label = anonymized
        ? `Answer ${LETTERS[i] ?? `#${String(i + 1)}`}`
        : `Answer from ${s.name}`;
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
      : `Critique from ${critique.provider}`;
    blocks.push(`### ${label}\n${critique.result.text}`);
  }
  return blocks.join("\n\n");
}

/** Render the original messages as the "question" block for later phases. */
function renderConversation(messages: Message[]): string {
  if (messages.length === 1) {
    return messages[0]?.content ?? "";
  }
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}
