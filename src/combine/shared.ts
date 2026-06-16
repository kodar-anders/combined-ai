/**
 * Helpers shared by more than one combine strategy. A helper lives here only
 * once a second strategy actually reuses it (the 2–3x rule); strategy-private
 * helpers stay in that strategy's own file.
 */

import {
  type CombineEvent,
  type CombineRequest,
  type CombineUsage,
  type ParticipantOutcome,
} from "./index";
import { type ProviderName } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type Message,
  type Provider,
  type TextPart,
  type Usage,
} from "../types";

/**
 * A participant, kept with its resolved provider for the orchestration phases.
 * `id` is its unique label (surfaced in results/events); `providerName` is the
 * actual provider it runs on; `model`/`maxTokens` are its optional per-participant
 * overrides (applied by {@link completionFor}, falling back to the request's).
 */
export type RosterEntry = {
  id: string;
  providerName: ProviderName;
  provider: Provider;
  model?: string;
  maxTokens?: number;
};

/**
 * The per-participant request overrides {@link completionFor} applies on top of
 * the request-wide values. A {@link RosterEntry} (or `Survivor`/`Running.entry`)
 * is structurally a valid value, so callers pass the entry directly.
 */
export type ParticipantOverrides = Pick<RosterEntry, "model" | "maxTokens">;

/**
 * Wrap an optional progress callback into an `emit` that swallows handler errors
 * — a progress listener must never break the run. Returns a no-op-safe emitter
 * whether or not `onEvent` was supplied.
 */
export function makeEmitter(
  onEvent?: (event: CombineEvent) => void,
): (event: CombineEvent) => void {
  return (event) => {
    try {
      onEvent?.(event);
    } catch {
      // A progress listener must not break the run.
    }
  };
}

/**
 * Second pass over a user-facing answer. Prompt instructions in the generating
 * step alone don't reliably stop a model from narrating the process ("synthesizes
 * the drafts", "I improved the previous answer", "Answer A"), so this rewrite
 * strips that meta-commentary. It sees only the answer text — never the inputs or
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

/**
 * Build a per-phase completion request, carrying over the caller's
 * model/maxTokens/signal. A participant's per-participant `overrides` take
 * precedence over the request-wide `model`/`maxTokens` (which act as the fallback).
 */
export function completionFor(
  request: CombineRequest,
  system: string | undefined,
  messages: Message[],
  overrides?: ParticipantOverrides,
): CompletionRequest {
  const completion: CompletionRequest = { messages };
  if (system !== undefined) {
    completion.system = system;
  }
  const model = overrides?.model ?? request.model;
  if (model !== undefined) {
    completion.model = model;
  }
  const maxTokens = overrides?.maxTokens ?? request.maxTokens;
  if (maxTokens !== undefined) {
    completion.maxTokens = maxTokens;
  }
  // Carry the abort signal into every phase so one signal cancels the whole
  // combine (aborting all in-flight provider calls at once).
  if (request.signal !== undefined) {
    completion.signal = request.signal;
  }
  // Carry the response schema through (used by the ensemble strategy, where every
  // participant answers under the same schema; consensus/pipeline reject it at the
  // registry, so it's only ever set here for ensemble).
  if (request.responseFormat !== undefined) {
    completion.responseFormat = request.responseFormat;
  }
  return completion;
}

/** Prepend the caller's system prompt (if any) to a phase's framing instruction. */
export function composeSystem(
  userSystem: string | undefined,
  framing: string,
): string {
  return userSystem === undefined ? framing : `${userSystem}\n\n${framing}`;
}

/** Run one participant's completion, capturing success or failure as an outcome. */
export async function runOutcome(
  id: string,
  provider: ProviderName,
  run: () => Promise<CompletionResult>,
): Promise<ParticipantOutcome> {
  try {
    return { id, provider, status: "ok", result: await run() };
  } catch (error) {
    return {
      id,
      provider,
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Rewrite a user-facing answer to remove process narration (see
 * {@link SANITIZE_FRAMING}). On failure or empty output, returns the original
 * answer unchanged — a working (if slightly leaky) answer beats no answer.
 */
export async function sanitizeAnswer(
  provider: Provider,
  request: CombineRequest,
  answer: string,
  overrides?: ParticipantOverrides,
): Promise<{ text: string; usage?: Usage }> {
  try {
    const result = await provider.complete(
      completionFor(
        request,
        composeSystem(request.system, SANITIZE_FRAMING),
        [{ role: "user", content: answer }],
        overrides,
      ),
    );
    // The call was billed whether or not we keep its output, so report its usage.
    return {
      text: result.text.trim() === "" ? answer : result.text,
      usage: result.usage,
    };
  } catch {
    return { text: answer };
  }
}

/** A single model call's token usage, attributed (by id) to the participant that made it. */
export type UsageEntry = { id: string; usage?: Usage };

/** Map per-participant outcomes to usage entries (a failed outcome has no usage). */
export function outcomeUsage(outcomes: ParticipantOutcome[]): UsageEntry[] {
  return outcomes.map((o) => ({
    id: o.id,
    usage: o.status === "ok" ? o.result.usage : undefined,
  }));
}

/**
 * Sum per-call usages into a {@link CombineUsage} (overall total + per-participant
 * breakdown). Entries with no usage are ignored; returns `undefined` if no call
 * reported any usage at all.
 */
export function aggregateUsage(
  entries: UsageEntry[],
): CombineUsage | undefined {
  const byParticipant: Partial<Record<string, Usage>> = {};
  const total: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const { id, usage } of entries) {
    if (usage === undefined) {
      continue;
    }
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    const acc = byParticipant[id];
    byParticipant[id] = {
      inputTokens: (acc?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (acc?.outputTokens ?? 0) + usage.outputTokens,
      totalTokens: (acc?.totalTokens ?? 0) + usage.totalTokens,
    };
  }
  // byParticipant is non-empty iff at least one entry carried usage.
  return Object.keys(byParticipant).length === 0
    ? undefined
    : { total, byParticipant };
}

/**
 * Extract the plain text from a message's content: a `string` is returned as-is;
 * a `ContentPart[]` has its text parts concatenated. (Combine renders prompts as
 * text, so non-text parts don't propagate through the phases — a known limit.)
 */
function textOf(content: string | ContentPart[]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
}

/** Render the original messages as the "question" block for later phases. */
export function renderConversation(messages: Message[]): string {
  if (messages.length === 1) {
    return textOf(messages[0]?.content ?? "");
  }
  return messages
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m.content)}`,
    )
    .join("\n\n");
}
