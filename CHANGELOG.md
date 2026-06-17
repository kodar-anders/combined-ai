# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
