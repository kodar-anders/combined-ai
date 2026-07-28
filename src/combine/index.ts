/**
 * Public types for the **combine** feature — multiple providers cooperating on
 * one prompt via a selectable strategy. The strategy implementations live in
 * sibling files (e.g. `consensus.ts`); the public entry point is
 * {@link ProviderRegistry.combine}.
 */

import { type CostOptions } from "../models";
import { type ProviderName } from "../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type ResponseFormat,
  type Usage,
} from "../types";

/** The cooperation strategies the registry knows how to run. */
export const STRATEGY_NAMES = [
  "consensus",
  "pipeline",
  "ensemble",
  "broadcast",
  "panel",
] as const;

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
      /**
       * A per-participant system instruction (a role/persona). **Only the `panel`
       * strategy honors this today** — other strategies ignore it. It gives each
       * participant a distinct perspective, letting the same provider+model appear
       * several times as different experts. Layered as
       * `[request.system] + [instruction] + [phase framing]`.
       */
      instruction?: string;
    };

/**
 * The fields every combine strategy's request shares: the underlying
 * {@link CompletionRequest} (messages, model, maxTokens, system, signal, …) plus
 * the roster of participants. The per-strategy request types
 * ({@link ConsensusRequest}, {@link PipelineRequest}, {@link EnsembleRequest},
 * {@link BroadcastRequest}) extend this with only the options that strategy uses.
 */
export type CombineRequestBase = CompletionRequest & {
  /**
   * Who participates. A bare provider name uses its configured default model; the
   * object form ({@link ParticipantSpec}) overrides model/maxTokens per participant.
   * Resolved to a unique id each (see {@link ParticipantSpec.label}); validated by
   * the registry.
   */
  participants: ParticipantSpec[];
};

/**
 * Request for the `consensus` strategy (draft → critique → synthesize). Call
 * {@link ProviderRegistry.consensus} directly, or pass `strategy: "consensus"`
 * (the default) to {@link ProviderRegistry.combine}.
 */
export type ConsensusRequest = CombineRequestBase & {
  /**
   * Which participant writes the final synthesized answer, referenced by its
   * **id** (see {@link ParticipantSpec.label}). Defaults to the first participant.
   */
  synthesizer?: string;
  /**
   * Whether drafts are attributed to their provider in the text shown to the
   * other providers. `"anonymized"` (default) shows `Answer A`/`Answer B`/… to
   * neutralize brand and self-preference bias; `"attributed"` shows participant
   * ids. The returned {@link ConsensusResult} always keeps ids regardless.
   */
  attribution?: "attributed" | "anonymized";
  /**
   * Minimum number of participants that must successfully produce a draft for a
   * consensus run to proceed. Defaults to 2. A single-provider combine always
   * degrades to a plain completion regardless of this value.
   */
  minParticipants?: number;
};

/**
 * Request for the `pipeline` strategy (sequential refinement). Call
 * {@link ProviderRegistry.pipeline} directly, or pass `strategy: "pipeline"` to
 * {@link ProviderRegistry.combine}. No strategy-specific options — participant
 * order is the conveyor order.
 */
export type PipelineRequest = CombineRequestBase;

/**
 * Request for the `ensemble` strategy (multi-model vote on structured output).
 * Call {@link ProviderRegistry.ensemble} directly, or pass `strategy: "ensemble"`
 * to {@link ProviderRegistry.combine}. `responseFormat` is **required** (every
 * participant answers under this schema, and the field-wise vote needs an
 * object-root schema).
 */
export type EnsembleRequest = CombineRequestBase & {
  responseFormat: ResponseFormat;
};

/**
 * Request for the `broadcast` strategy (fan-out, no combine). Call
 * {@link ProviderRegistry.broadcast} directly, or pass `strategy: "broadcast"` to
 * {@link ProviderRegistry.combine}. No strategy-specific options.
 */
export type BroadcastRequest = CombineRequestBase;

/**
 * Request for the `panel` strategy (role-based experts → integrate). Call
 * {@link ProviderRegistry.panel} directly, or pass `strategy: "panel"` to
 * {@link ProviderRegistry.combine}. Each participant answers through its own
 * {@link ParticipantSpec.instruction} (role/persona), then the `synthesizer`
 * integrates the complementary perspectives into one answer — unlike consensus,
 * which adjudicates for a single correct answer.
 */
export type PanelRequest = CombineRequestBase & {
  /**
   * Which participant integrates the final answer, referenced by its **id** (see
   * {@link ParticipantSpec.label}). Defaults to the first participant.
   */
  synthesizer?: string;
  /**
   * Run a review round: each participant cross-examines the others' answers
   * through its own role lens before synthesis. Defaults to `false` (an extra
   * parallel burst of calls, so it's opt-in).
   */
  crossExamine?: boolean;
};

/**
 * The broad request accepted by the strategy-dispatching
 * {@link ProviderRegistry.combine}: {@link CombineRequestBase} plus every
 * strategy's options and the `strategy` selector — {@link ConsensusRequest}'s
 * options (`synthesizer`/`attribution`/`minParticipants`) plus panel's
 * `crossExamine`, plus `strategy`. Each strategy reads only the options it uses
 * (e.g. `crossExamine` is ignored outside panel, like `attribution` is outside
 * consensus); `responseFormat` stays optional here, inherited from
 * {@link CompletionRequest}. Prefer a per-strategy method
 * ({@link ProviderRegistry.consensus} etc.) when the strategy is known at the
 * call site — they take the precise {@link ConsensusRequest}/… type and return
 * the concrete result without narrowing.
 */
export type CombineRequest = ConsensusRequest & {
  /** Cooperation strategy. Defaults to `"consensus"`. */
  strategy?: StrategyName;
  /**
   * Run a review round in the `panel` strategy (panel-only; ignored elsewhere).
   * See {@link PanelRequest.crossExamine}.
   */
  crossExamine?: boolean;
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
 * One model call's token usage, tagged with the participant `id` that made it and
 * the `model` it used. Keeping each call's own model (rather than the pre-summed
 * {@link CombineUsage.byParticipant}) is what lets `combineCost` price calls
 * individually — see `combineCost` for why that's the only correct way.
 */
export type CallUsage = {
  /** The participant id that made this call. */
  id: string;
  /** The model this call actually used (its `result.model`). */
  model: string;
  /** This call's token usage. */
  usage: Usage;
};

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
  /**
   * Every billed model call, in completion order, each tagged with its model and
   * usage. The per-call ledger `combineCost` prices (see {@link CallUsage}); it
   * holds only calls that reported usage. The default consensus run records its
   * drafts, critiques, synthesis (one entry per attempt, including discarded
   * fallback attempts), and the sanitize pass.
   */
  calls: CallUsage[];
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
  /**
   * A {@link SemanticComparison} of the surviving drafts — present only when
   * {@link CombineOptions.embedding} was set and at least two drafts survived.
   * **Informational; it does not influence synthesis.** Whole-draft cosine
   * reflects topical overlap as much as agreement on the conclusion, so read
   * `agreement` as a soft signal — the `outlier` (the most divergent drafter) is
   * the more actionable half.
   */
  draftAgreement?: SemanticComparison;
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
  /**
   * How many responses the vote actually counted — the **denominator** of every
   * {@link byField} score. This is the number of participants that returned a valid
   * structured object, so it's ≤ `responses.length` (a failed call, or one whose
   * `parsed` isn't a plain object, doesn't vote). Paired with a field's winning vote
   * count (`votes[field].candidates.find((c) => c.winner)?.ids.length`) it gives the
   * two integers a confidence model wants, without re-deriving them from the ratio.
   */
  validResponseCount: number;
};

/**
 * One distinct value returned for a field, with the participants that returned it.
 * Values are grouped by the **same deep equality the vote uses**, so two models
 * emitting the same object with different key order form one candidate.
 */
export type EnsembleFieldCandidate = {
  /**
   * The value, exactly as the participant(s) returned it. This is the **same
   * object reference** as `merged[field]` (for the winner) and as the participant's
   * own `responses[i].result.parsed[field]` — mutating it mutates all of them, so
   * treat it as read-only.
   */
  value: unknown;
  /**
   * The participant ids that returned this value, in participant order. Never
   * empty, and unique by construction (the registry validates participant ids).
   * These are participant **ids**, not provider names — they coincide only when no
   * `label` was set; otherwise join back to `responses` for the provider/model.
   */
  ids: string[];
  /**
   * True for the candidate that won the vote — the value in `merged[field]`.
   * Exactly one candidate per field carries it.
   */
  winner: boolean;
};

/**
 * The full vote for one field of the merged object: every value a participant
 * returned for it, and who omitted it. This is the breakdown `merged` and
 * `agreement` were computed **from** — not a side signal — so a reviewer can show
 * "one model said `1245.00`, the other two said `12450.00`" without re-walking
 * `responses` and reimplementing the vote's equality rule.
 */
export type EnsembleFieldVote = {
  /**
   * Every distinct value returned for this field, in first-seen participant order
   * (the order is stable across runs; the winner is flagged, not sorted first). A
   * single entry means unanimous **among the participants that returned the field**;
   * two or more is dissent.
   */
  candidates: EnsembleFieldCandidate[];
  /**
   * The participant ids that omitted this field. They still count against
   * `agreement.byField[field]` (the denominator is all valid responses), so this is
   * what distinguishes a low score caused by **sparse coverage** from one caused by
   * **disagreement**. Empty when every participant returned the field.
   */
  absent: string[];
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
  /**
   * Per-field vote breakdown: which value each participant returned, grouped by the
   * vote's own deep equality, plus who omitted the field. Keyed identically to
   * `merged` and `agreement.byField` (the first-seen union of the participants'
   * keys), so a per-field view can iterate one and index the others — note
   * {@link semanticAgreement} is the exception, covering only string fields.
   *
   * This is the record of how `merged` was produced, so it's always present. The
   * dissenting fields are one filter away:
   * `Object.entries(votes).filter(([, v]) => v.candidates.length > 1)`.
   */
  votes: Record<string, EnsembleFieldVote>;
  /**
   * Per-field **semantic** agreement (mean pairwise cosine, in `[-1, 1]` —
   * typically 0–1 for text) over the string-valued fields — present only when
   * {@link CombineOptions.embedding} was set. For each such field, the mean
   * pairwise cosine similarity of the participants' values, so
   * paraphrases ("Paris" vs "the city of Paris") score high while genuinely
   * different answers score low — the meaning-aware companion to the exact-match
   * `agreement` above. **Purely informational:** the `merged` value is still the
   * deterministic exact-match vote, never chosen by similarity.
   */
  semanticAgreement?: Record<string, number>;
  /** Each participant's structured response, in participant order (includes failures). */
  responses: ParticipantOutcome[];
  /** Aggregated token usage across every participant call, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/**
 * A semantic comparison of several participants' answers, computed by embedding
 * them with one designated model (see {@link CombineEmbedding}) and comparing the
 * vectors. **Informational only** — it ranks and scores the answers; it never
 * changes a returned or merged value.
 */
export type SemanticComparison = {
  /**
   * Overall agreement: the mean pairwise cosine similarity across the compared
   * answers, in `[-1, 1]` (higher = the models converged more). `1` when fewer
   * than two answers were compared.
   */
  agreement: number;
  /**
   * The participant id whose answer is farthest from the group centroid — the
   * dissenter. Set only when **three or more** answers were compared (with two,
   * both are equidistant, so there is no meaningful outlier).
   */
  outlier?: string;
  /**
   * Groups of participant ids whose answers are mutually similar (cosine at or
   * above the internal clustering threshold), in participant order. A heuristic
   * grouping — read it as "these models said roughly the same thing".
   */
  clusters: string[][];
};

/**
 * The result of the `broadcast` strategy (fan-out to every participant in
 * parallel, no cooperation). There is no single combined answer — hence no
 * `text` field — just every participant's raw response. Narrow on
 * `result.strategy` to reach `responses`.
 */
export type BroadcastResult = {
  strategy: "broadcast";
  /** Each participant's raw completion, in participant order (includes failures). */
  responses: ParticipantOutcome[];
  /**
   * A {@link SemanticComparison} of the participants' answers — present only when
   * {@link CombineOptions.embedding} was set and at least two non-empty answers
   * came back. Informational: every raw response is still returned unchanged.
   */
  semantic?: SemanticComparison;
  /** Aggregated token usage across every participant call, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/** The result of the `panel` strategy (role-based experts → integrate). */
export type PanelResult = {
  /** The final integrated answer. */
  text: string;
  strategy: "panel";
  /** The id of the participant that integrated the final answer (may be a fallback if the chosen one failed). */
  synthesizer: string;
  /** The model the synthesizer actually used. */
  model: string;
  /** Phase 1 role answers, in participant order (includes any failures). */
  answers: ParticipantOutcome[];
  /** Phase 2 cross-examination reviews, in surviving-participant order (empty when `crossExamine` was off). */
  reviews: ParticipantOutcome[];
  /**
   * A {@link SemanticComparison} of the surviving role answers — present only
   * when {@link CombineOptions.embedding} was set and at least two answers
   * survived. **Informational; it does not influence synthesis.** Unlike the
   * other strategies, for a panel *low* agreement is expected and healthy (the
   * roles are meant to differ); *high* agreement is the signal worth noticing —
   * it means the roles collapsed to the same answer. The `outlier` names the most
   * divergent role.
   */
  perspectiveAgreement?: SemanticComparison;
  /** Aggregated token usage across every call, or `undefined` if none was reported. */
  usage?: CombineUsage;
};

/**
 * The result of a combine, discriminated on `strategy`. Narrow on
 * `result.strategy` to reach the strategy-specific artifacts. Note that
 * `BroadcastResult` has no `text` (it returns every raw response, not one answer).
 */
export type CombineResult =
  | ConsensusResult
  | PipelineResult
  | EnsembleResult
  | BroadcastResult
  | PanelResult;

/**
 * Maps a strategy name to its request type — e.g. `StrategyRequest<"ensemble">`
 * is {@link EnsembleRequest}. A utility for callers writing code generic over the
 * strategy.
 */
export type StrategyRequest<S extends StrategyName> = {
  consensus: ConsensusRequest;
  pipeline: PipelineRequest;
  ensemble: EnsembleRequest;
  broadcast: BroadcastRequest;
  panel: PanelRequest;
}[S];

/**
 * Maps a strategy name to its concrete result type — e.g.
 * `ResultFor<"ensemble">` is {@link EnsembleResult}. A utility for callers
 * writing code generic over the strategy.
 */
export type ResultFor<S extends StrategyName> = Extract<
  CombineResult,
  { strategy: S }
>;

/**
 * A progress event emitted while a combine runs. For `consensus`, `phase` marks
 * a phase boundary and `draft`/`critique` fire as each participant's call settles
 * (in completion order, which may differ from participant order). For `pipeline`,
 * a `stage` event fires as each stage settles (in conveyor order). For `ensemble`
 * and `broadcast`, a `response` event fires as each participant settles (in
 * completion order, which may differ from participant order). For `panel`, `phase`
 * marks a boundary and `answer`/`review` fire as each participant settles. The
 * final answer is the resolved {@link CombineResult}, so there is no terminal event.
 *
 * Every **settlement** event (`draft`/`critique`/`answer`/`review`/`stage`/
 * `response`) carries that participant's {@link ParticipantOutcome}, so a UI can
 * render partial results as they land: `status: "ok"` guarantees `result` (the full
 * {@link CompletionResult} — `text`, `model`, `usage`, and `parsed` for a structured
 * `ensemble` response), and `status: "failed"` guarantees `error`. Three things to
 * know before rendering that content:
 *
 * 1. **What the text is differs per event type.** `draft`/`critique` (consensus)
 *    and `answer`/`review` (panel) are **process material**: their framing tells the
 *    model its reply is read by another assistant or an integrator, not an end user,
 *    so the text can be in-character, role-scoped, or meta-referential — label it as
 *    intermediate work rather than presenting it as the answer. A `broadcast`
 *    `response` is an ordinary reply to the caller's own prompt. An `ensemble`
 *    `response` is the **raw JSON** of the structured answer, so read `result.parsed`
 *    rather than `result.text`. A pipeline `stage` is addressed to the user, but it is
 *    pre-sanitize — see (3).
 * 2. **`status: "ok"` means the call succeeded, not that its output was used.** An
 *    `ok` outcome with empty text is dropped from the next phase (a consensus draft
 *    or panel answer stops being a survivor — and consensus can still go on to
 *    throw on `minParticipants`; a pipeline stage doesn't advance the running
 *    answer). An `ensemble` `response` whose `result.parsed` isn't a plain object is
 *    excluded from the merge. Check `status === "ok"` *and* non-empty text before
 *    treating a settlement as accepted.
 * 3. **The last settlement event's text is not the final answer.** Synthesis and
 *    the sanitizing rewrite run *after* the last settlement event and emit no event
 *    of their own, so the resolved {@link CombineResult} is the only source of truth
 *    for `text`.
 *
 * `event.result` is **frozen**, because it is the same object that lands in the
 * result's `drafts`/`stages`/`responses` and is rendered into the next phase's
 * prompt — an in-place edit would otherwise corrupt the run. Writing to it throws
 * (and the emitter swallows the error, so the run is unaffected); copy before
 * editing. The freeze is shallow: nested `usage`/`parsed` are not frozen, so treat
 * those as read-only by convention.
 *
 * Shipping an event elsewhere (a log sink, a worker, an SSE feed) needs care with the
 * `error`: `JSON.stringify` omits its `message` (non-enumerable on `Error`), keeping
 * only a `ProviderError`'s own fields, while `structuredClone` keeps the message but
 * downgrades a `ProviderError` to a plain `Error`, dropping `status`/`kind`/`code`.
 * Neither round-trips it — map what you need to a plain object yourself (e.g.
 * `{ message: error.message, status }`). Note too that an event copies the
 * participant's whole output text, so logging events wholesale is not cheap.
 */
export type CombineEvent =
  | {
      type: "phase";
      phase:
        "drafting" | "critiquing" | "synthesizing" | "answering" | "reviewing";
    }
  | ({
      /** A `consensus` participant's draft settled. */
      type: "draft";
    } & ParticipantOutcome)
  | ({
      /** A `consensus` participant's critique settled. */
      type: "critique";
    } & ParticipantOutcome)
  | ({
      /** A `panel` participant's role answer settled. */
      type: "answer";
    } & ParticipantOutcome)
  | ({
      /** A `panel` participant's cross-examination review settled. */
      type: "review";
    } & ParticipantOutcome)
  | ({
      /** A `pipeline` stage settled. `index` is its 0-based position in the conveyor. */
      type: "stage";
      index: number;
    } & ParticipantOutcome)
  | ({
      /** A participant settled in an `ensemble` or `broadcast` run. */
      type: "response";
    } & ParticipantOutcome)
  | {
      /**
       * A {@link CombineBudget} signal. Two cases, distinguished by which field is
       * set:
       * - **skip** (`skipped` set): the running cost crossed `budgetUsd`, so an
       *   *optional* phase was dropped to stay near budget — consensus
       *   `"critiques"`/`"sanitize"`, panel `"reviews"`/`"sanitize"`, or a pipeline
       *   `"refine"` stage/`"sanitize"`. For a skipped pipeline refiner, `id`/`index`
       *   identify the stage not run.
       *   Required phases still run, so `spentUsd` can exceed `budgetUsd`.
       * - **under-enforced** (`underEnforced: true`): emitted once when a settled
       *   call couldn't be priced (unknown model, or no usage reported) and so
       *   contributes 0 to `spentUsd`. The budget is then incomplete and may never
       *   trigger — pass `budget.models` to price custom models.
       *
       * `spentUsd` is the cost priced so far; `budgetUsd` is the configured ceiling.
       */
      type: "budget";
      spentUsd: number;
      budgetUsd: number;
      skipped?: "critiques" | "refine" | "sanitize" | "reviews";
      underEnforced?: boolean;
      id?: string;
      index?: number;
    };

/**
 * An optional spend ceiling for a combine, in USD. **A best-effort soft floor on
 * *optional* work, not a hard cap on total spend:** in-flight calls and the phases
 * required to produce an answer (consensus drafts + synthesis, the pipeline's first
 * stage) always run and bill, so the realized cost can exceed `usd`. Once the
 * running cost crosses `usd`, the combine launches no further *optional* calls
 * (consensus critiques/sanitize; pipeline refiners/sanitize) and emits a `budget`
 * {@link CombineEvent}.
 *
 * Cost is priced per call with the built-in pricing registry; pass `models` (the
 * {@link CostOptions} override) to price models the registry doesn't know. **A call
 * whose model can't be priced — or that reports no usage — contributes 0 to the
 * running cost**, so a budget over a roster of entirely uncatalogued models never
 * triggers; a one-shot `budget` event with `underEnforced: true` is emitted the
 * first time this happens so the gap is observable. Budget on the
 * `ensemble`/`broadcast` strategies is accepted for a uniform API but **inert** —
 * their single parallel fan-out has no later phase to gate, so they emit no
 * `budget` event; price a finished run with `combineCost(result)` instead.
 */
export type CombineBudget = { usd: number } & CostOptions;

/**
 * Embed participant answers with a **single** designated model to compute a
 * {@link SemanticComparison}. Cross-provider vectors live in different spaces and
 * aren't comparable, so all answers are embedded with this one provider+model.
 *
 * Used by `broadcast` today (attached as {@link BroadcastResult.semantic}); the
 * other strategies accept it but don't act on it yet. The comparison is purely
 * informational — it never changes a returned or merged value.
 */
export type CombineEmbedding = {
  /** A configured provider that supports embeddings (its `embed` method). */
  provider: ProviderName;
  /** The embedding model (defaults to that provider's default embedding model). */
  model?: string;
};

export type CombineOptions = {
  /**
   * Called with progress events as the combine runs. Errors thrown from the
   * handler are swallowed so a progress listener can never break the run.
   *
   * Settlement events carry the participant's {@link ParticipantOutcome} — its
   * `result` (or `error`) — so a UI can render each draft/answer/stage as it lands.
   * See {@link CombineEvent} for what that content is and isn't safe to present.
   */
  onEvent?: (event: CombineEvent) => void;
  /**
   * An optional USD spend ceiling. See {@link CombineBudget} — it is a soft floor
   * on optional work, not a hard cap on total spend.
   */
  budget?: CombineBudget;
  /**
   * Embed participant answers to compute a semantic comparison (see
   * {@link CombineEmbedding}). Informational; used by `broadcast` today.
   */
  embedding?: CombineEmbedding;
};
