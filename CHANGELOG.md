# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
