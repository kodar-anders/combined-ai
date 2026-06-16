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
export const STRATEGY_NAMES = ["consensus", "pipeline", "ensemble"] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

/**
 * One participant in a combine. A bare provider name uses that provider's
 * configured default model; the object form overrides the model and/or maxTokens
 * for this participant only — letting one combine mix cheap drafters with a strong
 * synthesizer, or run the same provider twice with different models.
 */
export type ParticipantSpec =
  | ProviderName
  | {
      /** Which configured provider to run this participant on (validated by the registry). */
      provider: ProviderName;
      /** Model for this participant. Falls back to `request.model`, then the provider default. */
      model?: string;
      /** maxTokens for this participant. Falls back to `request.maxTokens`. */
      maxTokens?: number;
      /**
       * Unique id for this participant in results/events/usage and for `synthesizer`.
       * Defaults to the provider name, or `<provider>-<model>` when `model` is set.
       * Required (must be set explicitly) only to disambiguate two participants that
       * would otherwise resolve to the same id (e.g. the same provider+model twice).
       */
      label?: string;
    };

export type CombineRequest = CompletionRequest & {
  /**
   * Who participates. A bare provider name uses its configured default model; the
   * object form ({@link ParticipantSpec}) overrides model/maxTokens per participant.
   * Resolved to a unique id each (see {@link ParticipantSpec.label}); validated by
   * the registry.
   */
  participants: ParticipantSpec[];
  /**
   * **Consensus only.** Which participant writes the final synthesized answer,
   * referenced by its **id** (see {@link ParticipantSpec.label}). Defaults to the
   * first participant. Ignored by the `pipeline` strategy, where the last
   * successful stage produces the answer.
   */
  synthesizer?: string;
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
 * `id` is the participant's unique id (see {@link ParticipantSpec.label}); `provider`
 * is the actual provider it ran on (these differ when a model override gives the
 * participant a `<provider>-<model>` id, or two participants share one provider).
 * A failure's `error` is typically a `ProviderError` (carrying `status`/`kind`/
 * `code`); narrow with `instanceof ProviderError` to read those fields.
 */
export type ParticipantOutcome =
  | {
      id: string;
      provider: ProviderName;
      status: "ok";
      result: CompletionResult;
    }
  | { id: string; provider: ProviderName; status: "failed"; error: Error };

/**
 * Aggregated token usage across all the model calls a combine made — the true
 * cost of a run, which is several times one completion (a default 3-way
 * consensus is ~8 calls: 3 drafts + 3 critiques + synthesis + sanitize).
 * `undefined` if no participating provider reported usage.
 */
export type CombineUsage = {
  /** Total usage summed across every call the combine made. */
  total: Usage;
  /** Usage per participant id, summed across all of that participant's calls. */
  byParticipant: Partial<Record<string, Usage>>;
};

/** The result of the `consensus` strategy (draft → critique → synthesize). */
export type ConsensusResult = {
  /** The final synthesized answer. */
  text: string;
  strategy: "consensus";
  /** The id of the participant that wrote the final answer (may be a fallback if the chosen one failed). */
  synthesizer: string;
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
  /** The id of the participant that produced the final answer (the last advancing stage). */
  finalParticipant: string;
  /** The model that produced the final answer. */
  model: string;
  /** Every stage in pipeline (participant) order, including any failures. */
  stages: ParticipantOutcome[];
  /** Aggregated token usage across every stage, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/**
 * How strongly the ensemble participants agreed on the merged object — the
 * confidence signal a multi-model vote gives you that a single model can't.
 */
export type EnsembleAgreement = {
  /** Mean of the per-field agreement scores (0–1), or 1 for an empty object. */
  overall: number;
  /**
   * Per-field agreement: the fraction of the merged responses that voted for the
   * field's merged value (0–1). The denominator is **all** the valid responses,
   * not just the ones that returned the field — so a field most models omitted
   * scores low. 1 means every model returned the field and agreed on its value; a
   * low value flags either disagreement or sparse coverage.
   */
  byField: Record<string, number>;
};

/**
 * The result of the `ensemble` strategy (each participant returns the same typed
 * object; the objects are merged field-wise by majority vote — with no LLM
 * synthesis — so every merged value is one a model actually returned).
 */
export type EnsembleResult = {
  /** The merged object serialized as JSON (the same content as `merged`). */
  text: string;
  strategy: "ensemble";
  /** The merged typed object. Cast to your schema's type. */
  merged: Record<string, unknown>;
  /** How strongly the participants agreed, overall and per field. */
  agreement: EnsembleAgreement;
  /** Each participant's structured response, in participant order (includes failures). */
  responses: ParticipantOutcome[];
  /** Aggregated token usage across every participant call, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/**
 * The result of a combine, discriminated on `strategy`. Narrow on
 * `result.strategy` to reach the strategy-specific artifacts.
 */
export type CombineResult = ConsensusResult | PipelineResult | EnsembleResult;

/**
 * A progress event emitted while a combine runs. For `consensus`, `phase` marks
 * a phase boundary and `draft`/`critique` fire as each participant's call settles
 * (in completion order, which may differ from participant order). For `pipeline`,
 * a `stage` event fires as each stage settles (in conveyor order). For `ensemble`,
 * a `response` event fires as each participant's structured answer settles. The
 * final answer is the resolved {@link CombineResult}, so there is no terminal event.
 */
export type CombineEvent =
  | { type: "phase"; phase: "drafting" | "critiquing" | "synthesizing" }
  | {
      type: "draft";
      id: string;
      provider: ProviderName;
      status: "ok" | "failed";
    }
  | {
      type: "critique";
      id: string;
      provider: ProviderName;
      status: "ok" | "failed";
    }
  | {
      /** A `pipeline` stage settled. `index` is its 0-based position in the conveyor. */
      type: "stage";
      id: string;
      provider: ProviderName;
      status: "ok" | "failed";
      index: number;
    }
  | {
      type: "response";
      id: string;
      provider: ProviderName;
      status: "ok" | "failed";
    };

export type CombineOptions = {
  /**
   * Called with progress events as the combine runs. Errors thrown from the
   * handler are swallowed so a progress listener can never break the run.
   */
  onEvent?: (event: CombineEvent) => void;
};
