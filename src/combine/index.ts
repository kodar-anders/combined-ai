/**
 * Public types for the **combine** feature — multiple providers cooperating on
 * one prompt via a selectable strategy. The strategy implementations live in
 * sibling files (e.g. `consensus.ts`); the public entry point is
 * {@link ProviderRegistry.combine}.
 */

import { type ProviderName } from "../registry";
import { type CompletionRequest, type CompletionResult } from "../types";

/** The cooperation strategies the registry knows how to run. */
export const STRATEGY_NAMES = ["consensus"] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export type CombineRequest = CompletionRequest & {
  /** Which configured providers participate. Picked by name, validated by the registry. */
  participants: ProviderName[];
  /**
   * Which participant writes the final synthesized answer. Must be one of
   * `participants`. Defaults to the first participant.
   */
  synthesizer?: ProviderName;
  /** Cooperation strategy. Defaults to `"consensus"` (the only one for now). */
  strategy?: StrategyName;
  /**
   * Whether drafts are attributed to their provider in the text shown to the
   * other providers. `"anonymized"` (default) shows `Answer A`/`Answer B`/… to
   * neutralize brand and self-preference bias; `"attributed"` shows provider
   * names. The returned {@link CombineResult} always keeps provider names
   * regardless of this setting.
   */
  attribution?: "attributed" | "anonymized";
  /**
   * Minimum number of participants that must successfully produce a draft for a
   * consensus run to proceed. Defaults to 2. A single-provider combine always
   * degrades to a plain completion regardless of this value.
   */
  minParticipants?: number;
};

/** The outcome of one participant in one phase — either its result or its failure. */
export type ParticipantOutcome =
  | { provider: ProviderName; status: "ok"; result: CompletionResult }
  | { provider: ProviderName; status: "failed"; error: Error };

export type CombineResult = {
  /** The final synthesized answer. */
  text: string;
  /** The strategy that produced it. */
  strategy: StrategyName;
  /** The participant that wrote the final answer (may be a fallback if the chosen one failed). */
  synthesizer: ProviderName;
  /** The model the synthesizer actually used. */
  model: string;
  /** Phase 1 drafts, in participant order (includes any failures). */
  drafts: ParticipantOutcome[];
  /** Phase 2 critiques, in surviving-participant order (includes any failures). */
  critiques: ParticipantOutcome[];
};

/**
 * A progress event emitted while a combine runs. `phase` marks a phase boundary;
 * `draft`/`critique` fire as each participant's call settles (in completion
 * order, which may differ from participant order). The final answer is the
 * resolved {@link CombineResult}, so there is no terminal event.
 */
export type CombineEvent =
  | { type: "phase"; phase: "drafting" | "critiquing" | "synthesizing" }
  | { type: "draft"; provider: ProviderName; status: "ok" | "failed" }
  | { type: "critique"; provider: ProviderName; status: "ok" | "failed" };

export type CombineOptions = {
  /**
   * Called with progress events as the combine runs. Errors thrown from the
   * handler are swallowed so a progress listener can never break the run.
   */
  onEvent?: (event: CombineEvent) => void;
};
