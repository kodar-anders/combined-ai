/**
 * Public types for the **combine** feature — multiple providers cooperating on
 * one prompt via a selectable strategy. The strategy implementations live in
 * sibling files (e.g. `consensus.ts`); the public entry point is
 * {@link ProviderRegistry.combine}.
 */

import { type ProviderName } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type Usage,
} from "../types";

/** The cooperation strategies the registry knows how to run. */
export const STRATEGY_NAMES = ["consensus", "pipeline"] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export type CombineRequest = CompletionRequest & {
  /** Which configured providers participate. Picked by name, validated by the registry. */
  participants: ProviderName[];
  /**
   * **Consensus only.** Which participant writes the final synthesized answer.
   * Must be one of `participants`. Defaults to the first participant. Ignored by
   * the `pipeline` strategy, where the last successful stage produces the answer.
   */
  synthesizer?: ProviderName;
  /** Cooperation strategy. Defaults to `"consensus"`. */
  strategy?: StrategyName;
  /**
   * **Consensus only.** Whether drafts are attributed to their provider in the
   * text shown to the other providers. `"anonymized"` (default) shows
   * `Answer A`/`Answer B`/… to neutralize brand and self-preference bias;
   * `"attributed"` shows provider names. The returned {@link CombineResult}
   * always keeps provider names regardless of this setting. Ignored by the
   * `pipeline` strategy, which passes a single unlabelled running answer along.
   */
  attribution?: "attributed" | "anonymized";
  /**
   * **Consensus only.** Minimum number of participants that must successfully
   * produce a draft for a consensus run to proceed. Defaults to 2. A
   * single-provider combine always degrades to a plain completion regardless of
   * this value. Ignored by the `pipeline` strategy, which returns whatever the
   * best surviving stage produced (it needs only one stage to succeed).
   */
  minParticipants?: number;
};

/**
 * The outcome of one participant in one phase — either its result or its failure.
 * A failure's `error` is typically a `ProviderError` (carrying `status`/`kind`/
 * `code`); narrow with `instanceof ProviderError` to read those fields.
 */
export type ParticipantOutcome =
  | { provider: ProviderName; status: "ok"; result: CompletionResult }
  | { provider: ProviderName; status: "failed"; error: Error };

/**
 * Aggregated token usage across all the model calls a combine made — the true
 * cost of a run, which is several times one completion (a default 3-way
 * consensus is ~8 calls: 3 drafts + 3 critiques + synthesis + sanitize).
 * `undefined` if no participating provider reported usage.
 */
export type CombineUsage = {
  /** Total usage summed across every call the combine made. */
  total: Usage;
  /** Usage per participant, summed across all of that participant's calls. */
  byParticipant: Partial<Record<ProviderName, Usage>>;
};

/** The result of the `consensus` strategy (draft → critique → synthesize). */
export type ConsensusResult = {
  /** The final synthesized answer. */
  text: string;
  strategy: "consensus";
  /** The participant that wrote the final answer (may be a fallback if the chosen one failed). */
  synthesizer: ProviderName;
  /** The model the synthesizer actually used. */
  model: string;
  /** Phase 1 drafts, in participant order (includes any failures). */
  drafts: ParticipantOutcome[];
  /** Phase 2 critiques, in surviving-participant order (includes any failures). */
  critiques: ParticipantOutcome[];
  /** Aggregated token usage across every call, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/** The result of the `pipeline` strategy (sequential refinement). */
export type PipelineResult = {
  /** The final answer — the output of the last stage that produced one. */
  text: string;
  strategy: "pipeline";
  /** The participant that produced the final answer (the last advancing stage). */
  finalProvider: ProviderName;
  /** The model that produced the final answer. */
  model: string;
  /** Every stage in pipeline (participant) order, including any failures. */
  stages: ParticipantOutcome[];
  /** Aggregated token usage across every stage, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/**
 * The result of a combine, discriminated on `strategy`. Narrow on
 * `result.strategy` to reach the strategy-specific artifacts.
 */
export type CombineResult = ConsensusResult | PipelineResult;

/**
 * A progress event emitted while a combine runs. For `consensus`, `phase` marks
 * a phase boundary and `draft`/`critique` fire as each participant's call settles
 * (in completion order, which may differ from participant order). For `pipeline`,
 * a `stage` event fires as each stage settles (in conveyor order). The final
 * answer is the resolved {@link CombineResult}, so there is no terminal event.
 */
export type CombineEvent =
  | { type: "phase"; phase: "drafting" | "critiquing" | "synthesizing" }
  | { type: "draft"; provider: ProviderName; status: "ok" | "failed" }
  | { type: "critique"; provider: ProviderName; status: "ok" | "failed" }
  | {
      /** A `pipeline` stage settled. `index` is its 0-based position in the conveyor. */
      type: "stage";
      provider: ProviderName;
      status: "ok" | "failed";
      index: number;
    };

export type CombineOptions = {
  /**
   * Called with progress events as the combine runs. Errors thrown from the
   * handler are swallowed so a progress listener can never break the run.
   */
  onEvent?: (event: CombineEvent) => void;
};
