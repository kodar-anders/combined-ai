# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.1] - 2026-09-05

### Added

- Pricing for `claude-fable-5-1`, `gpt-6-astra`, `gemini-3.8-flash` and `gemini-3.7-flash`.

### Changed

- **Google default model is now `gemini-3.8-flash`** (GA 2026-09-02, same price as the previous
  `gemini-3.6-flash` default).
- Pricing corrected against the official pages (verified 2026-09-05): `claude-sonnet-5` is now
  $2/$10 (the launch price became permanent), and the `gpt-5.6-sol`/`-terra`/`-luna` rows carry
  OpenAI's August 2026 price cut ($4/$20, $2/$12, $0.20/$1.20).

## [2.1.0] - 2026-08-08

### Added

- **`synthesizeText`**: a standalone, single-provider helper that merges independent text
  candidates (e.g. `ensemble()`'s `votes[field].candidates`) into one coherent answer via a
  single LLM call. It's not a combine strategy — no roster, no critique round — just
  `synthesizeText(provider, prompt, candidates, options?)` returning a plain `CompletionResult`.

## [2.0.1] - 2026-07-29

### Fixed

- **`ensemble` now names every excluded participant when nothing voted.** `EnsembleResult.excluded`
  shipped in 2.0.0 to make a silently-dropped participant visible, but it was unreachable in the worst
  case: when _no_ participant returns a usable object the strategy throws, so there is no result to
  read it from. And when every response was `ok` but unparseable — typically all truncated at the token
  cap, the exact case 2.0.0's release notes advertise — nothing threw, so the error carried no `.errors`
  either. The caller could not tell "all three truncated" from "my schema has a non-object root".

  The thrown message now lists the same `id: reason` pairs as `excluded`, e.g.
  `Ensemble failed: no participant returned a valid structured object (anthropic: unparsed, openai: unparsed)`.
  A run that produces a result is unaffected; only the all-excluded error message changed.

## [2.0.0] - 2026-07-29

A deliberate major one day after `1.0.0`, not a versioning slip: the fix below for `cacheControl` on
`system` has to reject input that `1.0.0` accepted, and holding it back would leave a silent no-op in
place for another release. Most of this release is about the same failure mode — **things the library
did silently** — so each entry says what used to be invisible. Read the **Breaking** section in full:
two of the five items are consequences of those fixes rather than intentional API changes, and one of
them affects `onEvent` handlers.

### Breaking

- **`cacheControl` on a `SystemPrompt` now throws under `consensus`, `pipeline` and `panel`.** It was
  previously accepted and silently discarded, so the prompt-cache optimization never applied and
  nothing said so. Those strategies concatenate your text with their own per-phase framing into a
  single string, which leaves no block boundary for a breakpoint to mark — it can only be relocated
  to cover the framing too, which is not what you asked for.

  To migrate: remove `cacheControl` from `system`, move the marker onto a leading message content
  part, or switch to `ensemble`/`broadcast` — which now **honor** it on `system` (see **Fixed**).

- **`JSON.stringify(providerError)` changes shape** (see `ProviderError.toJSON()` under **Added**): it
  gains `message` and loses `body`. `body` was a duplicate — `apiError` already embeds it verbatim in
  `message` — and it can be large. Read `err.body` off the live object if you need it separately.

- **`CombineCost.unpriced` and `EnsembleResult.excluded` are required fields.** Only breaking if you
  _construct_ those result objects yourself (plausible with `combined-ai/test` fakes); reading them is
  additive.

- **`CombineEvent` has a new `embedding` member, which breaks `onEvent` handlers that narrow by
  elimination.** If your handler special-cases `phase` and `budget` and treats _everything else_ as a
  settlement event — the natural shape in 1.0.0, where it was true — a failed embedding now reaches
  that branch, where it has no `provider`/`status`. TypeScript consumers get a compile error
  (`Property 'provider' does not exist on type …`); plain JS logs `undefined`.

  To migrate: add a `case "embedding"` (it carries `error`) before the settlement branch, or switch
  the fallthrough to an explicit list of the six settlement types. The `onEvent` example in
  [Combine strategies](./docs/strategies.md#progress-events) shows the updated shape.

- **A `cacheControl` marker on `system` now counts toward Anthropic's 4-breakpoint limit under
  `ensemble`/`broadcast`.** That follows from the fix below — the marker reaches the provider now
  instead of being dropped — but it shrinks the budget available to message content parts by one. If
  you were already at 4 content-part breakpoints _and_ marked `system`, you are now at 5, and
  `prepareCacheControl` throws inside `complete()`, which combine records as a failed participant
  outcome rather than a thrown error. Drop one marker.

### Added

- **`temperature` on `CompletionRequest`**, forwarded by all three providers and by every `combine`
  phase. Omitted from the request entirely when unset, so existing calls are byte-identical.

  **Check your model before using it.** Anthropic _removed_ the parameter on its current line (Opus
  4.7+, Sonnet 5, Fable 5 — including this library's default `claude-opus-5`): setting it there is a
  **400**, not a no-op. Gemini accepts it on every current model, as do `openai-compatible` custom
  providers; OpenAI's reasoning-tier models have historically rejected non-default values. The value
  is passed through as-is (ranges differ per provider and the provider validates its own), but a
  non-finite value throws rather than reaching the wire as `null`. `temperature: 0` reduces
  run-to-run variation and is **not** a seed — these APIs aren't reproducible even at 0.

  **On a mixed `combine` roster, set it per participant** via `ParticipantSpec.temperature`, which
  wins over the request-wide value. A request-wide value reaches every participant, so one whose model
  rejects the parameter turns all of its calls into 400s — and under `consensus` those count as failed
  drafts, which can drop the survivor count below `minParticipants` and fail the whole run. A
  participant's temperature applies to every call it makes (critique and synthesis included): it is
  per participant, not per phase. Overrides replace rather than clear, so there is no way to exempt one
  participant from an inherited value — leave the request-wide one unset instead.
  `seed`/`topP`/`topK` are still out of scope.

- **`ProviderError.toJSON()`** — plain `JSON.stringify` now round-trips
  `{ name, message, provider, kind, status?, code?, type? }`, so logging a `ParticipantOutcome`,
  shipping it to a worker, or persisting it for replay no longer needs a hand-rolled mapping.
  Previously `message` was dropped (it's non-enumerable on `Error`) while `structuredClone` kept the
  message but downgraded to a plain `Error`, losing `status`/`kind`/`code`. A failure that isn't a
  `ProviderError` is still a plain `Error` and still stringifies to `{}`.

- **`CombineCost.unpriced`** — how many ledger entries couldn't be priced and are therefore excluded
  from `totalCost`. `combineCost` has always skipped those, so a run where half the ledger was dropped
  reported a small total indistinguishable from a genuinely cheap one. A call is unpriceable when its
  model is unknown to the registry _or_ its usage reported no prompt tokens.

  Read it as "how much of the ledger I had to skip", **not** as an all-clear: a call that reported no
  usage at all never enters `usage.calls`, so `combineCost` can neither price nor count it. Gemini's
  embedding endpoint reports no usage and OpenAI-compatible gateways often omit it on completions, so
  a run using either has billed calls invisible to both numbers. Don't gate billing on
  `unpriced === 0`.

- **`EnsembleResult.excluded`** — the participants that took no part in the vote, each with a
  `reason` of `"failed"` or `"unparsed"`. The second case was entirely silent: a response truncated
  at the token cap leaves `parsed` undefined, so that participant vanished from the merge with no
  event and no throw, and an apparently unanimous three-way vote could really have been a one-way
  one. Invariant: `responses.length - excluded.length === agreement.validResponseCount`. Adds
  `EnsembleExclusion`.

- **`embeddingError` on `consensus`, `ensemble`, `broadcast` and `panel` results, plus an
  `embedding` progress event.** A failed embedding call was swallowed, so a caller couldn't tell a
  broken embedder from one that was never configured. The failure is still never fatal — the answers
  are already paid for — but it is now reported. A comparison that merely _declines_ (fewer than two
  answers, or a provider returning a mismatched vector count) stays silent, because declining is a
  normal outcome. In `consensus`/`panel` the event's position in the stream is nondeterministic
  (the call overlaps the critique/review phase), and on their all-synthesizers-failed throw it is the
  only signal available.

### Fixed

- **`ensemble` no longer loses `semanticAgreement` to a single empty string.** Every eligible field's
  values go into one batched `embed()` call, and OpenAI's embeddings endpoint rejects an empty-string
  input — so one `""` anywhere, in any field, failed the whole request and silently dropped the score
  for _every_ field. Blank values are now filtered before the batch is built. Schemas that can't
  express an optional field push callers toward `""` as "absent", so this was easy to hit; the
  cross-provider strict-mode rules make it close to unavoidable.

- **`cacheControl` on `system` is now honored by `ensemble` and `broadcast`.** Those strategies
  forward the caller's prompt verbatim, so the breakpoint means exactly what you intended; it was
  dropped only because `completionFor` extracted the text and discarded the object. (The other three
  strategies now throw — see **Breaking**.)

- **Corrected the `CacheControl` documentation**, which claimed `combine` ignores the marker
  outright. It was already honored on message content parts, and the real rule is per phase: a
  content-part marker reaches the provider in the phases that forward your messages unchanged (every
  `ensemble`/`broadcast` call, the consensus drafts, the panel answers, the pipeline's first stage),
  while later phases re-render the conversation as text and drop it — as they do images and files.

## [1.0.0] - 2026-07-28

First stable release. The public API — the `Provider` contract, `ProviderRegistry`, the five
combine strategies, and the cost/embedding helpers — is now considered settled, and subsequent
breaking changes will come with a major bump. No migration is needed from `0.6.0` beyond the two
construction-side type changes noted under **Changed**.

### Added

- **Content-bearing `combine` progress events** — every settlement event
  (`draft`/`critique`/`answer`/`review`/`stage`/`response`) now carries the participant's
  `ParticipantOutcome`, so an `onEvent` listener can render partial results as they land instead of
  waiting for the whole run. `status: "ok"` guarantees `result` (the full `CompletionResult` —
  `text`, `model`, `usage`, and `parsed` for a structured `ensemble` response); `status: "failed"`
  guarantees `error`, which previously wasn't reported to a listener at all. `phase` and `budget`
  events are unchanged. Still no token-level streaming.

  A settled `CompletionResult` is now **frozen** (shallowly). An event hands out the same object
  the strategy later renders into the next phase's prompt and prices for the budget, so a listener
  editing it in place would corrupt the run; the freeze makes that write throw instead. This also
  freezes the copy reachable from the result's `drafts`/`stages`/`responses`, since it is the same
  object — copy before editing (`{ ...result, text: … }`).

- **Per-field vote detail on `ensemble`** — `EnsembleResult.votes` gives, for each field, every
  distinct value with the participant ids that returned it (`winner: true` on the one in `merged`)
  plus `absent`, the ids that omitted the field. Reading "one model said `1245.00`, the other two
  said `12450.00`" no longer means re-walking `responses` and reimplementing the vote's
  deep-equality grouping. `absent` is what distinguishes a low `agreement.byField` score caused by
  sparse coverage from one caused by disagreement. Adds `EnsembleFieldVote` and
  `EnsembleFieldCandidate`.

- **`EnsembleAgreement.validResponseCount`** — the denominator of every `byField` score (the number of
  participants that returned a valid structured object, so ≤ `responses.length`). Paired with a
  field's winning vote count it gives both integers a confidence model needs, without re-deriving
  them from the ratio or re-filtering `responses`.

- **Pricing entries** for Anthropic `claude-opus-5`, Google `gemini-3.6-flash`,
  `gemini-3.5-flash-lite` and `gemini-embedding-2` (text rate — the model is multimodal and
  bills higher for image/audio/video, which the table doesn't model). Prices re-verified across
  all three providers on 2026-07-28.

- **OpenAI cache-read rates** for `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`,
  `gpt-4.1-nano`, `o3` and `o4-mini` — the pricing page publishes them again. Cached input on
  these rows was previously billed at the full input rate. The discount is not a fixed multiple
  (0.25×–0.5× here vs 0.1× on the 5.x rows); the `-pro` rows still list none and keep falling
  back to the full rate.

### Fixed

- **`o4-mini` was priced at half its real rate** — $0.55/$2.20 per MTok in the table against
  OpenAI's published $1.10/$4.40. Any `costOf`/`combineCost` figure for `o4-mini` was understated
  by 50%.

- **A `__proto__` key in a model's structured output no longer corrupts the `ensemble` merge.**
  `JSON.parse` makes `__proto__` an ordinary own enumerable property, so building the merged object
  by index assignment invoked the prototype setter: the field silently vanished from `merged` and
  `text`, and the merged object's prototype was replaced by the model-supplied value. All four
  records keyed by model-supplied field names — `merged`, `agreement.byField`, `votes`, and
  `semanticAgreement` — are now built with `Object.fromEntries`, which defines a real own property.
  `semanticAgreement` was the sharpest case: a dropped numeric score read back as `Object.prototype`
  while still typed `number`, so a caller's `score.toFixed(2)` threw.

### Changed

- **Anthropic default model** is now `claude-opus-5` (was `claude-opus-4-8`). Same $5/$25 per MTok,
  and Anthropic's recommended starting model since its 2026-07-24 release. `claude-opus-4-8` stays
  in the pricing table and remains selectable via `model`.

- **Google default model** is now `gemini-3.6-flash` (was `gemini-3.5-flash`). Same $1.50 input,
  cheaper output ($7.50 vs $9.00), and Google's named successor for the retiring 2.5 flash line.
  The default embedding model stays `gemini-embedding-001`: `gemini-embedding-2` uses an
  incompatible embedding space, so switching it would invalidate stored vectors.

- **`CombineEvent`'s settlement variants are now intersections with `ParticipantOutcome`.**
  _Reading_ events is source-compatible — `event.id`/`provider`/`status`, `switch` narrowing, and an
  `onEvent` handler typed against the old shape all still work. **Constructing** one (a test fixture,
  a re-emitting wrapper, `satisfies CombineEvent`) now requires `result`/`error`. Events also
  serialize larger: a listener that JSON-logs whole events now logs each participant's full output
  text. Note that neither serializer round-trips a `failed` event's `error` — `JSON.stringify` omits
  its `message` (non-enumerable on `Error`), and `structuredClone` downgrades a `ProviderError` to a
  plain `Error`, dropping `status`/`kind`/`code` — so map the fields you need to a plain object.

- **`ensemble` ties now resolve to the first-seen value, as documented.** The vote previously picked
  the value that first _reached_ the winning count, which differs whenever an earlier-seen value's
  occurrences straddle another's — `A,B,B,A` merged to `B`, not `A`. Only reachable with **4 or more
  valid responses** (a 3-participant roster can't hit it), and `agreement` was unaffected either way,
  so the scores are unchanged; only which tied value lands in `merged`/`text` can differ.

- `EnsembleResult.votes` and `EnsembleAgreement.validResponseCount` are **required**, so _reading_ a
  result is source-compatible but **constructing** one (a test fixture, a hand-rolled double,
  `satisfies EnsembleResult`) now requires both fields.

## [0.6.0] - 2026-07-21

### Added

- **`panel` combine strategy** — a role-based expert panel (mixture-of-agents). Each participant
  answers the same prompt through its own `instruction` (role/persona), then a `synthesizer`
  **integrates** the complementary perspectives into one answer (rather than adjudicating for a
  single winner like `consensus`). Optional `crossExamine` review round; optional
  `perspectiveAgreement` semantic signal when an `embedding` is configured. Call
  `registry.panel(req)` or `combine({ strategy: "panel" })`. Adds `PanelRequest`/`PanelResult`,
  the `answer`/`review` progress events, and the `answering`/`reviewing` phases.
- **Per-participant `instruction`** on `ParticipantSpec` — a role/persona system prompt. Honored
  by the `panel` strategy today (other strategies ignore it), letting the same provider+model
  appear several times as different experts.
- **OpenAI pricing entries** for the GPT-5.6 family (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`;
  GA 2026-07-09) and `gpt-5.5-pro`. The 5.6 line is tiered Sol/Terra/Luna (no mini/nano this
  generation). `gpt-5.5-pro` has no published cache-read rate, so cached input falls back to the
  full input rate.

### Changed

- **OpenAI default model** is now `gpt-5.6-terra` (was `gpt-5.4`). It is OpenAI's positioned
  production default, one generation newer, at the same price point (`$2.50/$15` per 1M) as the
  previous default. Pass `model: "…"` to select any other model.
- **Google default model** is now `gemini-3.5-flash` (was `gemini-2.5-pro`). Google no longer
  serves `gemini-2.5-pro` to new API keys (it returned a 404), and the whole 2.5 generation is
  scheduled to retire 2026-10-16. `gemini-3.5-flash` is Google's official successor to
  `gemini-2.5-flash`. The 2.5 models remain in the pricing table for cost calculation; pass
  `model: "…"` explicitly to select any of them where still available.

## [0.5.0] - 2026-07-15

### Added

- **Per-request retry & timeout overrides**: `CompletionRequest` and `EmbeddingRequest` gained
  `retry?: RetryOptions` and `timeoutMs?: number`. `retry` merges field-by-field over the
  provider's construction-time retry (so `{ maxRetries: 0 }` disables retry while keeping the
  provider's `baseDelayMs`). `timeoutMs` is a whole-call wall-clock deadline (sugar for combining
  `signal` with `AbortSignal.timeout(ms)`) covering every retry attempt, the backoff waits, and —
  for `stream()` — the full body read; on expiry the call rejects with a transport `ProviderError`
  whose `cause` is a `TimeoutError`. An invalid `timeoutMs` (non-positive / non-finite / above the
  `setTimeout` ceiling) throws. `combine` and `fallback` forward both to every underlying provider
  call (per call, not run-wide — use `signal` for a run-wide budget). As part of this, a timeout or
  network failure that fires **during a response body read** — the success `.json()`, the SSE
  stream, or a non-2xx error body — is now wrapped as a transport `ProviderError` (previously a raw
  `DOMException`, which broke fallback advancement, especially for streaming timeouts).

- **Single-provider fallback chains** (`src/fallback.ts`): `registry.fallback(specs, options?)`
  returns a composable `Provider` that tries providers in order, catching a `ProviderError`
  and moving to the next (pairs with — doesn't replace — the per-provider `transport.ts`
  retry). A `spec` is a bare provider name or `{ provider, model?, maxTokens? }` whose
  overrides beat the per-call request, so a mixed chain can name a model per provider. When
  every provider fails it throws an `AggregateError` carrying each cause. `stream()` falls
  back only before the first delta (once a delta is emitted the chain is committed). Aborting
  the request's `signal` propagates without advancing the chain. `options.shouldFallback` and
  `options.onFallback` (both take a `FallbackEvent`) narrow the permissive default and observe
  advances. The returned provider has no `embed` (completion routing only). New exports:
  `FallbackSpec`, `FallbackOptions`, `FallbackEvent`.

### Changed

- Minimum Node version is now **20.3** (was 20): per-request `timeoutMs` combines a caller's
  signal with the timeout via `AbortSignal.any`, added in Node 20.3.

## [0.4.0] - 2026-07-08

### Added

- **`MockProvider` on the `combined-ai/test` subpath** (`src/testing/`): a network-free
  `Provider` for tests — canned/scripted/responder-driven completions, simulated stream
  deltas (lossless text split), call recording (`calls` + `reset()`), abort handling
  (transport `ProviderError`), and opt-in embeddings. Register it as a custom provider to
  drive `select()`/`combine` without (paid) API calls. The subpath also re-exports
  `ProviderError` so `instanceof` holds across the bundle boundary. New build entry;
  main-entry exports unchanged.

- **Current-generation models in the pricing table** (`src/models.ts`): added Anthropic
  `claude-sonnet-5` (standard $3/$15 rate) and `claude-opus-4-6`; OpenAI `gpt-5.5`,
  `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano` (with published cache-read rates) and the
  `o3` / `o4-mini` reasoning models; and Google `gemini-3.5-flash` and
  `gemini-3.1-flash-lite`. Existing `gpt-4o`/`gpt-4.1`/`gemini-2.5-*` entries are retained
  (still valid, just aging). Prices re-verified 2026-07-07 (`PRICING_VERIFIED_ON`).

### Changed

- **OpenAI default model** (`src/providers/openai.ts`): `gpt-4.1` → `gpt-5.4`. `gpt-4.1` is
  now grandfathered legacy (dropped from OpenAI's pricing page); `gpt-5.4` is the
  current-generation successor in the same balanced-workhorse role ($2.50/$15), not the
  pricier `gpt-5.5` flagship. Anthropic (`claude-opus-4-8`) and Google (`gemini-2.5-pro`)
  defaults are unchanged — the former is still the current flagship Opus, and the latter
  is still the most capable GA Gemini (the Gen-3 Pro tier is preview-only).

- **Dev tooling (no runtime/API impact)**: bumped dev dependencies within range
  (`eslint`, `typescript-eslint`, `prettier`, `@swc/core`, `eslint-plugin-jest`,
  `globals`) and `eslint-plugin-unicorn` 65 → 71. The unicorn major surfaced several
  new rules; the genuinely useful ones were adopted (a `Number.isSafeInteger` count
  check, a redundant-`else` cleanup) and the opinionated/naming/ES2024+ ones were
  disabled in `eslint.config.mjs` with rationale. `@types/node` and `typescript` were
  held back (the latter is capped by `typescript-eslint`'s peer range).

## [0.3.0] - 2026-06-25

### Added

- **Prompt-cache breakpoints (Anthropic)** (`src/types.ts`, `src/providers/anthropic.ts`):
  a new `CacheControl` (`{ ttl?: "1h" }`) marker can be placed on a content part via
  `cacheControl` (on `TextPart`/`ImagePart`/`FilePart`) or on the system prompt via the new
  object form `system: { text, cacheControl }` (`SystemPrompt`). The Anthropic provider
  emits `cache_control` on the matching content/system blocks, enforces the 4-breakpoint
  limit with a clear error (instead of a raw 400), and sends the `extended-cache-ttl`
  beta header only when a `ttl: "1h"` breakpoint is present. OpenAI and Gemini ignore the
  marker (they cache automatically / implicitly), reading only the system text. `combine`
  builds its own prompts and does not honor `cacheControl` (it forwards system text only).

- **Prompt-cache reporting + pricing** (`src/types.ts`, `src/providers`, `src/models.ts`,
  `src/cost.ts`): `Usage` gains optional `cachedInputTokens` (a discounted cache **read**)
  and `cacheCreationInputTokens` (an Anthropic cache **write**), both subsets of
  `inputTokens` and set only when the provider reports them. Each provider extracts its own
  cached-token fields (Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`,
  OpenAI `prompt_tokens_details.cached_tokens`, Gemini `cachedContentTokenCount`).
  `ModelPricing` gains optional `cachedInputPerMTok` (read rate, tier-aware via
  `highTier.cachedInputPerMTok`) and `cacheWriteInputPerMTok` (write rate); `costOf`/
  `costOfUsage` bill cache reads at the discount and writes at the premium, each falling
  back to the normal input rate when a model lists no cache rate (no fabricated discount).
  Anthropic (read 0.1× input, write 1.25× input — the 5-minute TTL rate, so 1-hour writes
  under-bill) and Gemini (read 0.1× input, tiered for 2.5 Pro) cache rates are carried;
  OpenAI cache rates are left unset (the live pricing page now lists only gpt-5.x, so the
  gpt-4.x entries couldn't be verified — cached calls price conservatively until then).
  Savings flow through `combineCost` and `combine` budget caps automatically. **Note:**
  this is `complete()`-only — `stream()` reports no usage today.

- **Embedding signals in `combine`** (`src/combine/embedding.ts`): a `CombineOptions.embedding`
  (`{ provider, model? }`) embeds participants' answers with a single designated model to add
  **informational** signals — they never change a returned or merged value, and a failed
  embedding pass never fails a run. The embedding call's usage folds into the result's usage
  ledger (attributed to the embedding provider). Per strategy:
  - **`broadcast`** → `BroadcastResult.semantic`: an overall `agreement` (mean pairwise cosine),
    the `outlier` (dissenting participant, farthest from the centroid), and `clusters` (which
    models said roughly the same thing).
  - **`consensus`** → `ConsensusResult.draftAgreement`: the same `SemanticComparison` over the
    surviving drafts (computed concurrently with critique/synthesis; does not influence the
    synthesized answer).
  - **`ensemble`** → `EnsembleResult.semanticAgreement`: per-field mean pairwise cosine over the
    **string-valued** fields (all values embedded in one batched call) — a meaning-aware
    companion to the exact-match vote, which still decides the `merged` value.
  - **`pipeline`** is intentionally unaffected (no parallel answers to compare).

- **Embeddings** (`src/embeddings.ts`, `src/providers`, `src/registry.ts`): an optional
  `embed?()` method on the `Provider` contract, with `ProviderRegistry.embed(name, text)`
  and `embedMany(name, texts)` as the access points (both throw a clear error when the
  selected provider doesn't support embeddings). OpenAI (`/v1/embeddings`, default
  `text-embedding-3-small`) and Google (`:batchEmbedContents`, default
  `gemini-embedding-001`) implement it; **Anthropic does not** (it has no first-party
  embeddings endpoint). `EmbeddingResult.usage` reuses `Usage` (`outputTokens: 0`) so
  embedding calls price through the existing cost layer; embedding-model prices were added
  to the registry (input-only, `outputPerMTok: 0`). A pure `cosineSimilarity(a, b)` helper
  is exported for comparing vectors. An optional `dimensions` reduces the output vector
  size (OpenAI `dimensions` / Gemini `outputDimensionality`).

### Changed

- **Anthropic `usage.inputTokens` is now the total billable prompt** (it includes cache
  reads/writes, which Anthropic reports in buckets outside `input_tokens`). Unchanged for
  non-cached calls; OpenAI/Gemini are unchanged (their prompt count already included cached
  tokens).

### Security

- Pin `undici` to `^6.27.0` via `resolutions` to clear four Dependabot advisories
  (1 high, 1 moderate, 2 low). It is a dev/build-only transitive dependency
  (`fsevents` → `node-gyp`) — the published library uses the global `fetch` and never
  imports `undici`.

## [0.2.0] - 2026-06-18

### Added

- **Combine cost aggregation + budget caps** (`src/combine/cost.ts`, `src/combine`):
  `combineCost(result, options?)` prices a finished combine in USD, summing each model
  call **individually** from a new per-call ledger so tiered rates and thinking
  residuals stay correct (never the lossy summed `byParticipant`). `CombineUsage` gains
  a `calls: CallUsage[]` ledger (each call tagged with its `model`). A `CombineOptions.budget`
  (`{ usd, ...CostOptions }`) tracks running cost and skips _optional_ phases once exceeded
  — consensus critiques/sanitize, pipeline refiners/sanitize — while required phases always
  run, so a run never ends empty (a soft floor on optional work, not a hard cap). A `budget`
  progress event reports skips and warns once (`underEnforced`) when a call can't be priced.
  Budget on the `ensemble`/`broadcast` fan-outs is accepted but informational (a single
  parallel burst can't be pre-empted).

- **Cost & pricing layer** (`src/cost.ts`, `src/models.ts`): `costOf(result)` and
  `costOfUsage(usage, model)` turn token usage into a `CostBreakdown` in USD, using
  a tiny built-in pricing registry. `findModel`/`listModels` expose the registry
  and `PRICING_VERIFIED_ON` dates it. Resolution maps dated snapshots / `modelVersion`
  to their base entry but declines differently-priced siblings (e.g. `gpt-4.1-nano`,
  `gemini-2.5-flash-lite`) rather than mis-pricing them. Tiered pricing is supported
  (Gemini 2.5 Pro's >200k-token tier); Gemini thinking tokens are billed at the
  output rate. Returns `undefined` (never throws) for an unknown model, missing
  usage, or empty/malformed usage. Pass `options.models` to extend or correct prices
  without a release.

## [0.1.1] - 2026-06-17

### Fixed

- Google (Gemini) provider: drop `additionalProperties` from `responseSchema`
  and tool `parameters`. The Gemini API now rejects the keyword with a 400
  instead of ignoring it, which broke structured output / ensemble combine.

### Security

- Pin transitive dev dependencies via `resolutions` to clear advisories (build/test
  tooling only — not shipped in the published package): `esbuild` to `0.28.1`
  (GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr) and `js-yaml` to `4.2.0`
  (GHSA-h67p-54hq-rp68).

### Changed

- Bump dev dependencies: `tsup` to `^8.5.1`, `@swc/core` to `^1.15.41`,
  `@swc/jest` to `^0.2.39`.

## [0.1.0] - 2026-06-17

Initial release: a plain TypeScript library that unifies the Anthropic, OpenAI,
and Google (Gemini) APIs behind one provider-agnostic contract, talking to each
HTTP API directly over `fetch` (no SDK dependencies), and adds strategies for
combining several providers on one prompt.

### Added

- **Provider-agnostic contract** (`src/types.ts`): `Provider`, `Message`, `Role`,
  `CompletionRequest`, `CompletionResult`. Every provider implements `complete()`
  (full text) and `stream()` (text deltas via SSE).
- **`ProviderRegistry`** — the package's single point of access, configured with
  `{ anthropic?, openai?, google?, custom? }`. `select(name)` returns a provider
  or throws (listing configured names); plus `has(name)` and `names()`. Concrete
  provider classes are intentionally not exported. The library never reads
  environment variables — keys come from config.
- **Anthropic, OpenAI, and Google (Gemini) providers.** Anthropic Messages API
  (default `claude-opus-4-8`); OpenAI Chat Completions (default `gpt-4.1`, folds
  `system` into a leading message, cap sent as `max_completion_tokens`); Gemini
  Generative Language API (default `gemini-2.5-pro`, `assistant`→`model`,
  `system`→`systemInstruction`, cap→`maxOutputTokens`). The `google` key is the
  company name (consistent with `anthropic`/`openai`); the API it speaks is Gemini.
  Note: Gemini 2.5 thinking tokens count against `maxTokens`, so a very small cap
  can leave the visible answer empty/truncated.
- **Custom & gateway providers** via a `custom` map on the registry config. Two
  forms — `{ kind: "openai-compatible", apiKey, baseUrl, model, headers?, retry? }`
  points the OpenAI provider at any Chat Completions–compatible endpoint
  (OpenRouter, Together, Groq, Ollama, a local server, …), and
  `{ kind: "provider", provider }` brings your own `Provider`. Custom providers
  work everywhere a built-in does; a name colliding with a built-in throws. A
  gateway's errors and `provider.name` carry its alias. `ProviderName` accepts any
  custom string while keeping autocomplete for the built-ins. Exported:
  `CustomProviderConfig`, `CustomProviderInstance`, `OpenAICompatibleConfig`,
  `BuiltInProviderName`. `OpenAIProviderOptions.headers?` adds extra headers
  merged into (and able to override) every request.
- **Combine: cooperate across providers on one prompt** via
  `ProviderRegistry.combine(request)` or the per-strategy methods `consensus()`,
  `pipeline()`, `ensemble()`, and `broadcast()`. Per-strategy methods take that
  strategy's request type (`ConsensusRequest`, `PipelineRequest`, `EnsembleRequest`,
  `BroadcastRequest`) and return its concrete result; `combine()` is generic over
  `strategy`, returning the concrete result for a literal strategy and the
  `CombineResult` union (discriminated on `strategy`) for a dynamic one. Four
  strategies:
  - **consensus** — every participant drafts in parallel, critiques all drafts
    (anonymized by default; `attribution: "attributed"` opts out), then a
    synthesizer adjudicates on correctness over popularity; a final sanitizing
    pass strips process narration. Tolerates partial failure down to
    `minParticipants` (default 2); a single participant degrades to a plain
    completion.
  - **pipeline** — participants refine one answer in sequence (participant order =
    conveyor order); a failed/empty stage carries the previous answer forward.
  - **ensemble** — every participant answers under the same `responseFormat`, then
    the objects are merged **mechanically** by field-wise majority vote (no LLM
    synthesis) with per-field and overall `agreement` scores. `responseFormat` is
    required (object root); rejected for consensus/pipeline/broadcast.
  - **broadcast** — fan the prompt out to every participant and return all raw
    answers, with no critique/synthesis/vote; `BroadcastResult` has no `text`.
  - A participant is a provider name or `{ provider, model?, maxTokens?, label? }`,
    so one combine can mix models or run the same provider twice; each gets a
    unique `id` (results/events/usage are keyed by it). An optional `CombineOptions`
    `onEvent` callback reports phase/per-participant progress (status only).
    When every participant fails, the thrown error is an `AggregateError` carrying
    the participants' own errors. Tools/`toolChoice` are not supported in combine.
    Exported: `CombineRequest`, `CombineResult`, `ConsensusResult`,
    `PipelineResult`, `EnsembleResult`, `EnsembleAgreement`, `BroadcastResult`,
    `ParticipantSpec`, `ParticipantOutcome`, `StrategyName`, `CombineEvent`,
    `StrategyRequest<S>`, `ResultFor<S>`, `CombineRequestBase`.
- **Structured message content**: `Message.content` is `string | ContentPart[]`
  (a bare string is shorthand for one text part).
- **Multimodal input**: `ContentPart` is `TextPart | ImagePart | FilePart` (plus
  `MediaSource`). Pass images and documents/PDFs alongside text, with `source` as
  base64 bytes or a URL, mapped to each provider's wire shape. Provider support
  varies — OpenAI's Chat Completions has no URL file source and throws a clear
  error.
- **Structured output**: `CompletionRequest.responseFormat?` (`{ type: "json_schema",
schema, name? }`) constrains output to a raw JSON Schema (no Zod), mapped to each
  provider's native mechanism. `complete()` also surfaces the parsed value on
  `CompletionResult.parsed`. For one schema to work across all three, set
  `additionalProperties: false` and list every property in `required`.
- **Tool / function calling** (single-provider, `complete()` only). Pass `tools`
  and an optional `toolChoice` (`"auto" | "any" | "none" | { name }`); a tool call
  is returned on `toolCalls` with `finishReason: "tool_use"`. Replay results with
  `ToolUsePart`/`ToolResultPart` content parts, mapped to each provider's wire
  shape. Exported: `ToolDefinition`, `ToolChoice`, `ToolCall`, `ToolUsePart`,
  `ToolResultPart`.
- **Normalized finish reasons and refusals**: `finishReason` (a `FinishReason`
  union) and `rawFinishReason` on `CompletionResult`, so a truncated/refused
  answer is distinguishable from a genuinely empty one. A provider `refusal` is
  surfaced and forces `finishReason: "content_filter"`.
- **Token usage accounting**: `CompletionResult.usage` (`Usage` of
  `inputTokens`/`outputTokens`/`totalTokens`), or `undefined` when none is
  reported. `CombineResult.usage` (`CombineUsage` with `total` plus a
  per-participant `byParticipant` breakdown) aggregates every model call a combine
  makes, so its true cost is visible.
- **Cancellation**: `CompletionRequest.signal?` (`AbortSignal`) is forwarded to
  every provider `fetch` and threaded through `combine()`, so one signal cancels
  every participant call. An aborted call rejects with a transport `ProviderError`.
- **Typed errors**: `ProviderError` (exported) carries `provider`, a `kind`
  discriminant (`"api"` vs `"transport"`), `status` (for `"api"`), and a
  `code`/`type` from the error body. `fetch` rejections are wrapped as
  `"transport"`; an HTTP 200 with an `{ error }` body throws instead of returning a
  silent empty result.
- **Automatic retry** with bounded exponential backoff on 429/503/529, for both
  `complete()` and `stream()`. Honors `Retry-After`; the backoff respects the
  request's `AbortSignal`. Configurable per provider via `retry`
  (`{ maxRetries?, baseDelayMs? }`, exported as `RetryOptions`; default 2 retries
  from 500ms, `0` disables). Transport failures are not retried.
- **Robust streaming**: SSE parsing tolerates blank/malformed `data:` frames, and
  `stream()` releases the response body reader on every exit path (normal end,
  error, or consumer `break`) so a long-running server can't leak a socket.
- Opt-in live integration tests (`*.integration.test.ts`), double-gated on
  `RUN_LIVE_TESTS=1` plus the provider key; combine suites are triple-gated. Run
  with `yarn test:integration` (optional filename pattern narrows to one suite).
