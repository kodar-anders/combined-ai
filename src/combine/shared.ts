/**
 * Helpers shared by more than one combine strategy. A helper lives here only
 * once a second strategy actually reuses it (the 2–3x rule); strategy-private
 * helpers stay in that strategy's own file.
 */

import {
  type CombineEvent,
  type CombineRequest,
  type ParticipantOutcome,
} from "./index";
import { type ProviderName } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type Message,
  type Provider,
} from "../types";

/** A participant, kept with its resolved provider for the orchestration phases. */
export type RosterEntry = { name: ProviderName; provider: Provider };

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

/** Build a per-phase completion request, carrying over the caller's model/maxTokens/signal. */
export function completionFor(
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
  // Carry the abort signal into every phase so one signal cancels the whole
  // combine (aborting all in-flight provider calls at once).
  if (request.signal !== undefined) {
    completion.signal = request.signal;
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
 * Rewrite a user-facing answer to remove process narration (see
 * {@link SANITIZE_FRAMING}). On failure or empty output, returns the original
 * answer unchanged — a working (if slightly leaky) answer beats no answer.
 */
export async function sanitizeAnswer(
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

/** Render the original messages as the "question" block for later phases. */
export function renderConversation(messages: Message[]): string {
  if (messages.length === 1) {
    return messages[0]?.content ?? "";
  }
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}
