# Combine strategies — deep reference

The behavior details, result shapes, and options for the five combine
strategies. New here? Start with
[Combining providers](../README.md#combining-providers) in the README, which has
the strategy table and one example each.

- [Consensus](#consensus)
- [Pipeline](#pipeline)
- [Ensemble](#ensemble)
- [Broadcast](#broadcast)
- [Panel](#panel)
- [Semantic comparison (optional)](#semantic-comparison-optional)
- [Per-participant models](#per-participant-models)
- [Reading the result](#reading-the-result)
- [Progress events](#progress-events)

## Consensus

Draft → critique → synthesize. Best when you want a single, well-reasoned answer
that other models have checked.

1. **Draft** — every participant answers the prompt in parallel.
2. **Critique** — every participant sees all drafts and critiques them, arguing
   for the best one and ending with a structured verdict.
3. **Synthesize** — the _synthesizer_ reads the drafts and critiques and writes
   the single final answer.

- **Anonymized by default.** Critics and the synthesizer see `Answer A`/`B`/`C`
  rather than model names, to neutralize brand and self-preference bias (pass
  `attribution: "attributed"` to opt out). The result still records each
  outcome's `id` and `provider`.
- **Correctness over popularity.** The synthesizer adopts a lone correct answer
  rather than averaging it away, and flags genuine disagreement instead of
  papering over it. The final answer is written fresh — it never alludes to the
  drafts, critiques, or internal labels (a final sanitizing pass strips any
  leftover meta-commentary).
- **Lean inter-model messages.** The draft/critique text passed between models
  drops greetings and filler but keeps reasoning and caveats, so critics can
  check the _why_. The user-facing synthesis is unconstrained.
- **A single participant** with a successful draft degrades to a plain completion
  (no critique/synthesis); if that lone draft fails or is empty, the run throws.
- **`minParticipants`** (default 2) is the minimum number of drafts required to
  proceed to critique/synthesis.
- Optional [draft agreement](#semantic-comparison-optional) via an `embedding`
  option.

## Pipeline

A conveyor belt: each participant refines the previous one's answer, in
**participant order**. The first writes an initial answer; each subsequent stage
gets the question plus the running answer and improves it; the **last stage to
produce an answer wins**.

- **Refiners preserve, not rewrite.** Each stage treats the current answer as a
  strong baseline — fix errors, fill gaps, sharpen wording, but keep what's
  correct (there's no downstream synthesizer to catch a regression).
- **The final answer is sanitized** when a refining stage actually changed it, to
  strip "I improved the previous answer…" narration. A first-stage answer or an
  unchanged passthrough is returned as-is (no wasted call).
- It throws only if no stage advanced.
- `synthesizer`, `attribution`, and `minParticipants` are consensus-specific and
  ignored here.

## Ensemble

A multi-model vote on **structured output** — the thing one provider can't give
you. Every participant answers independently under the same JSON Schema, the
typed objects are merged **mechanically** (no model adjudicates), and you get an
**agreement score**.

How the merge works (field-wise over the union of top-level keys):

- **Every field is a majority vote** — the most common value by deep equality,
  ties broken by participant order. The merged value is always one a model
  actually returned (never synthesized or averaged), so it stays within the
  schema's types.
- **Agreement** per field is the share of **all** valid responses that voted for
  the merged value; `overall` is the mean across fields. A field most models
  omitted scores low — a low score flags it for review.
- **`responseFormat` is required** for ensemble and **rejected** for the other
  strategies. Its schema must have an **object** root (the field-wise vote needs
  named fields).
- **The merge is shallow** — nested objects/arrays are voted on as whole values.
  Keep schemas to flat fields for the most useful per-field agreement.
- Optional [semantic agreement](#semantic-comparison-optional) over string fields
  via an `embedding` option.

## Broadcast

The simplest strategy: send the prompt to every participant **in parallel** and
get **all** of their answers back, unchanged. No critique, synthesis, or vote —
broadcast deliberately does **not** combine. Use it to compare models side by
side, or to drive your own selection/UI over the raw outputs.

- **No single answer**, so `BroadcastResult` has **no `text`** field — read
  `result.responses` (one outcome per participant, in participant order).
- **Each model answers the raw prompt** (no shaped framing) — you get the
  unmodified per-model reply.
- **Fails only when every participant fails**; one or more failures are recorded
  in `responses` and the run still returns the successes. An empty-text answer
  still counts as a success.
- **No structured output:** `responseFormat` is rejected (that's ensemble's job);
  `synthesizer`, `attribution`, and `minParticipants` are ignored.
- Optional [semantic comparison](#semantic-comparison-optional) via an `embedding`
  option.

## Panel

A **role-based panel**: each participant answers the same prompt through its own
`instruction` (a role/persona), then one participant **integrates** the
complementary perspectives into a single answer. Because the diversity comes from
the instruction, not the model, you can run the **same model several times** as
different experts. Unlike [consensus](#consensus) — which adjudicates for the one
correct answer — panel preserves each perspective's distinct contribution.

- **`instruction` defines the role.** It's a per-participant field on
  `ParticipantSpec`; only panel honors it (other strategies ignore it). Give
  panelists that share a provider+model distinct `label`s.
- **The synthesizer integrates neutrally** — it runs _without_ its own role
  instruction, so a participant that is also the synthesizer answers in character
  in phase 1 but integrates impartially at the end. It falls back to another
  survivor if the chosen one fails.
- **`crossExamine`** (default `false`) adds a review round where each panelist
  cross-examines the others through its own lens before synthesis — extra calls,
  so it's opt-in.
- **Degrades gracefully:** with a single surviving answer there is nothing to
  integrate, so that answer is returned (sanitized); it throws only when **no**
  participant answers. There is no `minParticipants`/`attribution`.
- **No structured output:** `responseFormat` is rejected (that's ensemble's job).
- Optional [perspective agreement](#semantic-comparison-optional) via an
  `embedding` option — for a panel, _low_ agreement is expected and healthy.

## Semantic comparison (optional)

Consensus, ensemble, broadcast, and panel can attach a semantic comparison of the
parallel answers, computed by embedding them with **one** designated model. Pass
an `embedding` option as the second argument to `combine()`:

```ts
const result = await registry.combine(
  {
    messages: [{ role: "user", content: "Name a good book on databases." }],
    participants: ["anthropic", "openai", "google"],
    strategy: "broadcast",
  },
  { embedding: { provider: "openai" } }, // one model embeds all answers
);

result.semantic?.agreement; // mean pairwise cosine — how much the models converged
result.semantic?.outlier; // the dissenting participant id (farthest from the centroid)
result.semantic?.clusters; // [["anthropic","openai"],["google"]] — who agreed with whom
```

It is **always informational** — it never changes a returned or merged value. The
embedding provider must be configured and support embeddings (so not
`"anthropic"`); all answers go through this one model because cross-provider
vectors aren't comparable. The embedding call's usage is folded into
`result.usage`, and the comparison is omitted if it can't be computed (fewer than
two non-empty answers, or the embedding call fails).

Where each strategy exposes it:

| Strategy    | Field                         | Notes                                                          |
| ----------- | ----------------------------- | -------------------------------------------------------------- |
| `broadcast` | `result.semantic`             | `agreement` / `outlier` / `clusters` over all answers.         |
| `consensus` | `result.draftAgreement`       | Same `SemanticComparison`, over the surviving drafts.          |
| `panel`     | `result.perspectiveAgreement` | Same, over the role answers — _low_ agreement is healthy here. |
| `ensemble`  | `result.semanticAgreement`    | Per-field mean-pairwise-cosine over **string** fields only.    |

For ensemble, the `merged` value is still the deterministic exact-match vote —
embeddings only add a meaning-aware score (so "Paris" vs "the city of Paris"
counts as agreement where the exact-match vote wouldn't).

## Per-participant models

Each participant is identified by an **id** (its label). A bare provider name has
an id equal to the provider name; the object form derives `<provider>-<model>`
when you set a model (or set `label` yourself). This lets one combine mix cheap
drafters with a strong synthesizer — and even run the **same provider twice**
with different models:

```ts
await registry.combine({
  messages,
  participants: [
    { provider: "google", model: "gemini-2.5-flash" }, // id "google-gemini-2.5-flash"
    { provider: "openai", model: "gpt-4.1-mini" }, //     id "openai-gpt-4.1-mini"
    { provider: "openai", model: "gpt-4.1" }, //          id "openai-gpt-4.1" (same provider, different model)
    { provider: "anthropic" }, //                         id "anthropic" (default model)
  ],
  synthesizer: "anthropic", // a strong model adjudicates the cheap drafts
});
```

Two participants that resolve to the same id are rejected unless you give one an
explicit `label`. A participant's `model`/`maxTokens` take precedence over the
request-wide values.

## Reading the result

Every outcome carries both an `id` (the participant label) and `provider` (the
actual provider it ran on); `usage` is aggregated across **every** model call the
run made (the true multi-call cost), keyed by `id`.

The per-strategy methods (`registry.consensus(req)`, `.pipeline(req)`, …) return
a concrete result type, so you never narrow a union:

```ts
const result = await registry.pipeline({ messages, participants });
result.finalParticipant; // typed PipelineResult — `stages`, `text`, … all in scope
```

`combine()` with a **literal** `strategy` is just as precise (it infers the
result type from `strategy`). You only narrow when the strategy is dynamic, in
which case `combine()` returns the `CombineResult` union discriminated on
`strategy`:

```ts
const strategy = pickStrategyAtRuntime(); // : StrategyName
const result = await registry.combine({ messages, participants, strategy });

result.usage; // { total, byParticipant, calls } — aggregated token usage, or undefined

if (result.strategy === "consensus") {
  result.text; // the final synthesized answer
  result.synthesizer; // id of the participant that wrote the final answer
  result.drafts; // each participant's first-pass answer (has .id, .provider)
  result.critiques; // each participant's critique
} else if (result.strategy === "pipeline") {
  result.text; // the final, refined answer
  result.finalParticipant; // id of the last stage that produced an answer
  result.stages; // each stage in conveyor order (ok/failed)
} else if (result.strategy === "ensemble") {
  result.text; // the merged object serialized as JSON
  result.merged; // the voted object
  result.agreement; // { overall, byField }
  result.responses; // each participant's structured answer (ok/failed)
} else if (result.strategy === "broadcast") {
  // No `text` — broadcast returns every raw answer, not one combined answer.
  result.responses; // each participant's raw answer in order (ok/failed)
} else if (result.strategy === "panel") {
  result.text; // the integrated answer
  result.answers; // each role's raw answer (participant order)
  result.reviews; // each role's cross-examination ([] when crossExamine is off)
}
```

`text` is present on every strategy **except** `broadcast` (which has no single
answer), so narrow on `result.strategy` before reading it.

**Partial failures are tolerated.** A participant that errors — or succeeds but
returns empty/invalid output — is recorded in the result and dropped from the
rest of the round; the run proceeds with the survivors. It throws only when too
few survive: consensus needs `minParticipants` drafts, pipeline needs at least
one advancing stage, ensemble needs at least one valid object, and broadcast
needs at least one participant to succeed. `combine()` also validates the request
up front and throws on bad input (no participants, duplicate ids, empty
`messages`, an out-of-range `minParticipants`, a `synthesizer` that isn't a
participant id, an unknown `strategy`, or a missing / non-object `responseFormat`
for ensemble).

## Progress events

`combine()` takes an optional second argument with an `onEvent` callback that
fires as the run progresses — handy for a status display. Events are status only
(no token streaming); the answer is still the resolved result.

```ts
await registry.combine(
  { messages, participants: ["anthropic", "openai"] },
  {
    onEvent: (event) => {
      switch (event.type) {
        case "phase":
          console.log(`→ ${event.phase}`); // consensus phase boundary
          break;
        case "draft":
        case "critique": // consensus
        case "answer":
        case "review": // panel
        case "stage": // pipeline (has .index)
        case "response": // ensemble, broadcast
          console.log(`  ${event.provider}: ${event.status}`); // "ok" | "failed"
          break;
        case "budget": // a phase was skipped to stay near budget
          console.log(
            `  budget: skipped ${event.skipped ?? "(under-enforced)"}`,
          );
          break;
      }
    },
  },
);
```

Errors thrown from `onEvent` are swallowed so a listener can't break the run, and
there is no terminal event (the result is the return value). See
[Combine cost & budgets](./cost-and-caching.md#combine-cost--budgets) for the
`budget` event.
