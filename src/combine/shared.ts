/**
 * Helpers shared by more than one combine strategy. A helper lives here only
 * once a second strategy actually reuses it (the 2–3x rule); strategy-private
 * helpers stay in that strategy's own file.
 */

import {
  type CallUsage,
  type CombineBudget,
  type CombineEvent,
  type CombineRequest,
  type CombineUsage,
  type ParticipantOutcome,
} from "./index";
import { costOfUsage } from "../cost";
import { aggregateError } from "../errors";
import { type CostOptions } from "../models";
import { type ProviderName } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type Message,
  type Provider,
  type SystemPrompt,
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
  system: string | SystemPrompt | undefined,
  messages: Message[],
  overrides?: ParticipantOverrides,
): CompletionRequest {
  const completion: CompletionRequest = { messages };
  // Combine builds its own framing and doesn't apply prompt caching, so forward
  // only the system text — a caller's SystemPrompt cacheControl is dropped here.
  const text = systemText(system);
  if (text !== undefined) {
    completion.system = text;
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

/**
 * The text of a caller's system prompt, dropping any {@link SystemPrompt}
 * cacheControl — combine builds its own prompts and doesn't honor cache markers.
 */
function systemText(
  system: string | SystemPrompt | undefined,
): string | undefined {
  return typeof system === "object" ? system.text : system;
}

/** Prepend the caller's system prompt (if any) to a phase's framing instruction. */
export function composeSystem(
  userSystem: string | SystemPrompt | undefined,
  framing: string,
): string {
  const text = systemText(userSystem);
  return text === undefined ? framing : `${text}\n\n${framing}`;
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
 * Run every participant against the **verbatim** prompt (the caller's own
 * `system` + `messages`, with no shaped framing) in parallel, capturing each as a
 * {@link ParticipantOutcome} and emitting a `response` event as it settles. Shared
 * by the fan-out strategies (`ensemble`, `broadcast`); each strategy keeps its own
 * accept/throw policy on the returned outcomes. Per-participant model/maxTokens
 * overrides and the abort `signal` thread through {@link completionFor}.
 */
export async function respondAll(
  roster: RosterEntry[],
  request: CombineRequest,
  emit: (event: CombineEvent) => void,
): Promise<ParticipantOutcome[]> {
  return Promise.all(
    roster.map(async (entry) => {
      const outcome = await runOutcome(entry.id, entry.providerName, () =>
        entry.provider.complete(
          completionFor(request, request.system, request.messages, entry),
        ),
      );
      emit({
        type: "response",
        id: entry.id,
        provider: entry.providerName,
        status: outcome.status,
      });
      return outcome;
    }),
  );
}

/**
 * Build the error a strategy throws when no participant produced a usable result.
 * The combine-specific adapter over {@link aggregateError}: it collects the failed
 * participants' own errors (each a `ProviderError` with status/kind/abort cause)
 * so the thrown error carries them as `.errors` when any participant failed, and
 * degrades to a plain `Error` when every participant succeeded but none was usable
 * (e.g. all empty or non-object). The `message` is preserved either way, so
 * existing `toThrow(...)` assertions still pass.
 */
export function noResultError(
  message: string,
  outcomes: ParticipantOutcome[],
): Error {
  return aggregateError(
    message,
    outcomes.flatMap((o) => (o.status === "failed" ? [o.error] : [])),
  );
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
): Promise<{ text: string; model?: string; usage?: Usage }> {
  try {
    const result = await provider.complete(
      completionFor(
        request,
        composeSystem(request.system, SANITIZE_FRAMING),
        [{ role: "user", content: answer }],
        overrides,
      ),
    );
    // The call was billed whether or not we keep its output, so report its model
    // and usage (so it lands in the per-call ledger and is priced).
    return {
      text: result.text.trim() === "" ? answer : result.text,
      model: result.model,
      usage: result.usage,
    };
  } catch {
    // No call completed (it threw) → no model/usage to report.
    return { text: answer };
  }
}

/**
 * A single model call's token usage, attributed (by id) to the participant that
 * made it. `model` is the model that call actually used (`result.model`), kept so
 * the call can be priced individually (see {@link CombineUsage.calls}); both
 * `model` and `usage` are absent for a call that failed or reported no usage.
 */
export type UsageEntry = { id: string; model?: string; usage?: Usage };

/**
 * Map per-participant outcomes to usage entries (a failed outcome has neither
 * model nor usage; an `ok` outcome always carries its `result.model`).
 */
export function outcomeUsage(outcomes: ParticipantOutcome[]): UsageEntry[] {
  return outcomes.map((o) => ({
    id: o.id,
    model: o.status === "ok" ? o.result.model : undefined,
    usage: o.status === "ok" ? o.result.usage : undefined,
  }));
}

/**
 * The priceable per-call entries: those carrying **both** `model` and `usage`, as
 * {@link CallUsage}. Failed outcomes (no model/usage) and ok calls that reported no
 * usage are dropped. Used to feed the per-call ledger and the {@link BudgetTracker}.
 */
export function callUsages(entries: UsageEntry[]): CallUsage[] {
  return entries.flatMap((e) =>
    e.model !== undefined && e.usage !== undefined
      ? [{ id: e.id, model: e.model, usage: e.usage }]
      : [],
  );
}

/**
 * Sum a running accumulator (or `undefined` to start) plus one call's usage. The
 * optional cache subtotals are summed too and kept only when non-zero — the same
 * "present only when reported" grain as {@link Usage}, so a cache-free run's
 * aggregate stays `{inputTokens, outputTokens, totalTokens}`.
 */
function sumUsage(acc: Usage | undefined, add: Usage): Usage {
  const cachedInputTokens =
    (acc?.cachedInputTokens ?? 0) + (add.cachedInputTokens ?? 0);
  const cacheCreationInputTokens =
    (acc?.cacheCreationInputTokens ?? 0) + (add.cacheCreationInputTokens ?? 0);
  return {
    inputTokens: (acc?.inputTokens ?? 0) + add.inputTokens,
    outputTokens: (acc?.outputTokens ?? 0) + add.outputTokens,
    totalTokens: (acc?.totalTokens ?? 0) + add.totalTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
  };
}

/**
 * Sum per-call usages into a {@link CombineUsage}: the overall `total`, the
 * per-participant `byParticipant` breakdown, and the per-call `calls` ledger. Cache
 * subtotals are carried through {@link sumUsage} (so `total`/`byParticipant` expose
 * the same cache fields as each call). Entries with no usage are ignored for
 * `total`/`byParticipant`; `calls` holds only the priceable entries (see
 * {@link callUsages}). Returns `undefined` if no call reported any usage at all.
 */
export function aggregateUsage(
  entries: UsageEntry[],
): CombineUsage | undefined {
  const byParticipant: Partial<Record<string, Usage>> = {};
  let total: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const { id, usage } of entries) {
    if (usage === undefined) {
      continue;
    }
    total = sumUsage(total, usage);
    byParticipant[id] = sumUsage(byParticipant[id], usage);
  }
  // byParticipant is non-empty iff at least one entry carried usage.
  return Object.keys(byParticipant).length === 0
    ? undefined
    : { total, byParticipant, calls: callUsages(entries) };
}

/**
 * Tracks running combine cost against an optional {@link CombineBudget}. `add`
 * prices each settled call (per call — never a summed block, which would mishandle
 * tiered rates) and accumulates the dollars; `exceeded()` reports whether the
 * running cost reached the ceiling. A call that can't be priced (unknown model, or
 * no usage) contributes 0; the first such call under a budget emits a one-shot
 * `budget` event with `underEnforced: true`, so a budget silently doing nothing
 * over uncatalogued models is observable. With no budget configured the tracker is
 * a no-op that never exceeds (so callers need no special-casing).
 */
export type BudgetTracker = {
  /**
   * Price the priceable entries (those carrying both `model` and `usage`; see
   * {@link callUsages}) into the running total. Accepts the loose {@link UsageEntry}
   * list strategies already build, so callers don't pre-filter.
   */
  add: (entries: UsageEntry[]) => void;
  /**
   * Budget-gate an optional phase. If the budget is spent, emit a `budget` skip
   * event naming `skipped` (with optional `id`/`index` for a pipeline refiner
   * stage) and return `true` so the caller skips that phase; otherwise return
   * `false`. A no-op tracker (no budget configured) always returns `false`, so
   * strategies gate uniformly without re-checking whether a budget was set.
   */
  gate: (
    skipped: "critiques" | "refine" | "sanitize",
    extra?: { id?: string; index?: number },
  ) => boolean;
};

/** Build a {@link BudgetTracker} for `budget` (a no-op tracker when it's undefined). */
export function makeBudget(
  budget: CombineBudget | undefined,
  emit: (event: CombineEvent) => void,
): BudgetTracker {
  if (budget === undefined) {
    return {
      add: () => {
        // No budget configured: nothing to track.
      },
      gate: () => false,
    };
  }
  const options: CostOptions = { models: budget.models };
  let spent = 0;
  let warned = false;
  // Gate on *priced* spend: until a call actually prices (spent > 0) the budget
  // has measured nothing, so it never triggers — this is what makes a budget over
  // an entirely unpriceable roster inert (and keeps a `usd: 0` budget from skipping
  // optional work it never measured a cost for).
  const exceeded = (): boolean => spent > 0 && spent >= budget.usd;
  return {
    add(entries) {
      for (const call of callUsages(entries)) {
        const cost = costOfUsage(call.usage, call.model, options);
        if (cost === undefined) {
          // Can't price this call → it contributes 0, so the budget is now
          // incomplete. Warn once so the under-enforcement isn't silent.
          if (!warned) {
            warned = true;
            emit({
              type: "budget",
              spentUsd: spent,
              budgetUsd: budget.usd,
              underEnforced: true,
            });
          }
          continue;
        }
        spent += cost.totalCost;
      }
    },
    gate(skipped, extra) {
      if (!exceeded()) {
        return false;
      }
      emit({
        type: "budget",
        spentUsd: spent,
        budgetUsd: budget.usd,
        skipped,
        ...extra,
      });
      return true;
    },
  };
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
