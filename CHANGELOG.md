# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fourth combine strategy, **broadcast** (`strategy: "broadcast"`) — fan one
  prompt out to every participant in parallel and return **all** of their raw
  answers, with no critique, synthesis, or vote (it deliberately does not
  combine). Each model answers the prompt verbatim (no shaped framing). The
  result (`BroadcastResult`, exported) carries `responses` (one outcome per
  participant, in participant order, including failures) and `usage`, but **no
  `text`** — there is no single combined answer, so narrow on `result.strategy`
  before reading `text` on a `CombineResult`. Fails only when every participant
  fails (one or more failures are recorded and the successes are still returned;
  an empty-text answer still counts as a success). Reuses the `response` progress
  event. `responseFormat` is rejected for broadcast (structured output is the
  ensemble strategy's job), and the consensus-only options (`synthesizer`,
  `attribution`, `minParticipants`) are ignored.
- Combine "no usable result" errors now carry their causes. When every
  participant fails, the error a strategy throws (consensus, pipeline, ensemble,
  broadcast) is an `AggregateError` whose `.errors` are the participants' own
  errors (e.g. each `ProviderError` with its `status`/`kind`), so a caller can see
  _why_ the run failed instead of a flat message. When participants succeeded but
  produced nothing usable (all empty/non-object), a plain `Error` is thrown as
  before. Messages are unchanged.
- Per-participant models in `combine()`. A participant can now be an object —
  `{ provider, model?, maxTokens?, label? }` — instead of a bare provider name, so
  one combine can mix cheap drafters with a strong synthesizer, or run the **same
  provider twice with different models**. Each participant gets a unique **id**
  (its label): the provider name for a bare string, or `<provider>-<model>` when a
  model is set (override with `label`). Two participants resolving to the same id
  throw unless disambiguated. A participant's `model`/`maxTokens` take precedence
  over the request-wide values; an empty `model` or non-positive `maxTokens`
  override is rejected (omit the field to use the default). Combine
  results/events/usage now carry both the
  participant `id` and the actual `provider`; `usage.byParticipant` is keyed by id.
  `ParticipantSpec` is exported. **Breaking** (pre-release): `participants` is now
  `ParticipantSpec[]`, `synthesizer` is a participant id (`string`), and
  `PipelineResult.finalProvider` was renamed to `finalParticipant`.
- Custom & gateway providers: a `custom` map on `ProviderRegistryConfig`
  registers extra providers under names you choose. Two forms —
  `{ kind: "openai-compatible", apiKey, baseUrl, model, headers?, retry? }` points
  the OpenAI provider at any Chat Completions–compatible endpoint (OpenRouter,
  Together, Groq, Ollama, a local server, …), and `{ kind: "provider", provider }`
  brings your own `Provider` implementation. Custom providers work everywhere a
  built-in does (`select()`, `combine()` participants, results); a name that
  collides with a built-in throws at construction. An openai-compatible gateway's
  errors and `provider.name` carry its alias name (not a hardcoded `"openai"`), so
  `ProviderError.provider` identifies the gateway. `ProviderName` now accepts any
  custom string while keeping autocomplete for the built-ins. New exported types:
  `CustomProviderConfig`, `CustomProviderInstance`, `OpenAICompatibleConfig`,
  `BuiltInProviderName`.
- `headers?` option on `OpenAIProviderOptions` — extra headers merged into (and
  able to override) every request, for a gateway's auth/routing headers or a proxy.
- Core, provider-agnostic contract in `src/types.ts`: `Provider`, `Message`,
  `Role`, `CompletionRequest`, `CompletionResult`.
- Tool / function calling (single-provider, `complete()`). Pass `tools` (a
  `ToolDefinition[]` of `{ name, description?, parameters }`, where `parameters`
  is a JSON Schema) and an optional `toolChoice`
  (`"auto" | "any" | "none" | { name }`); when the model calls a tool,
  `complete()` returns `toolCalls` (a `ToolCall[]` of `{ id?, name, input }`, with
  OpenAI's JSON-string arguments parsed for you) and `finishReason: "tool_use"` (a
  new `FinishReason` member). Feed results back by replaying the conversation with
  the new `ToolUsePart` (assistant) and `ToolResultPart` (user) content parts;
  each provider maps them to its own wire shape (Anthropic `tool_use`/`tool_result`
  blocks, OpenAI assistant `tool_calls` and separate `tool`-role messages, Gemini
  `functionCall`/`functionResponse` parts). The caller orchestrates the loop; tool
  calls are surfaced by `complete()` only (not `stream()`), and tool calling is
  intentionally not part of `combine()`. All new types (`ToolDefinition`,
  `ToolChoice`, `ToolCall`, `ToolUsePart`, `ToolResultPart`) are exported.
- Structured message content: `Message.content` is now `string | ContentPart[]`.
  A bare `string` is shorthand for a single text part, so existing callers are
  unchanged; pass `ContentPart[]` for structured content. The `Message` widening
  is a one-time change; tool parts will add members later without breaking it.
- Structured output: `CompletionRequest.responseFormat?: ResponseFormat`
  (`{ type: "json_schema"; schema; name? }`, exported) constrains the output to a
  raw JSON Schema — no Zod/runtime dependency. Each provider maps it to its native
  mechanism (Anthropic `output_config.format`, OpenAI `response_format` with
  `strict: true`, Gemini `responseSchema` with the OpenAPI-3 subset). The model
  returns JSON in `text`, and `complete()` also surfaces the parsed value on
  `CompletionResult.parsed` (`undefined` when no schema was requested or the
  output wasn't valid JSON). For one schema to work across all three, set
  `additionalProperties: false` and list every property in `required`.
- Third combine strategy, **ensemble** (`strategy: "ensemble"`) — every
  participant answers the prompt under the same `responseFormat` (JSON Schema),
  then the typed objects are merged **mechanically** (no LLM synthesis) by
  field-wise **majority vote** (most common value by deep equality, first-seen
  tie-break), with a per-field and overall **agreement** score. The merged value
  is always one a model actually returned (never synthesized), and the agreement
  denominator is all valid responses, so a field most models omitted scores low.
  The result (`EnsembleResult`, exported with `EnsembleAgreement`) carries
  `merged`, `agreement`, and each participant's `responses`. `responseFormat` is
  **required** for ensemble (its schema must have an object root — array/scalar
  roots are rejected with a clear error) and **rejected** for consensus/pipeline
  (it would otherwise be silently ignored). A `response` progress event fires as
  each participant settles.
- Multimodal input: `ContentPart` is `TextPart | ImagePart | FilePart` (all
  exported, plus `MediaSource`). Pass images (`{ type: "image", source }`) and
  documents/PDFs (`{ type: "file", source, filename? }`) alongside text, where
  `source` is base64 bytes (`{ kind: "base64", mediaType, data }`) or a URL
  (`{ kind: "url", url, mediaType? }`). Each provider maps to its own wire shape
  (Anthropic `image`/`document` blocks, OpenAI `image_url`/`file` parts, Gemini
  `inlineData`/`fileData`). Provider support varies — OpenAI's Chat Completions
  has no URL file source, so that combination throws a clear error.
- `finishReason`, `rawFinishReason`, and `refusal` on `CompletionResult` plus a
  `FinishReason` union (`"stop" | "length" | "content_filter" | "other"`). Each
  provider's stop field (Anthropic `stop_reason`, OpenAI `finish_reason`, Gemini
  `finishReason`/prompt block reason) is mapped onto the normalized union, with
  the raw string preserved on `rawFinishReason`. Callers can now tell a
  truncated/refused answer apart from a genuinely empty one instead of seeing a
  bare `text: ""`. An OpenAI `message.refusal` (and Anthropic `type: "refusal"`
  blocks) are surfaced on `refusal` and force `finishReason` to `"content_filter"`.
- Token usage accounting. `CompletionResult.usage` (a `Usage` of
  `inputTokens`/`outputTokens`/`totalTokens`) is parsed from each provider's
  response (Anthropic `usage`, OpenAI `usage`, Gemini `usageMetadata` — whose
  `totalTokenCount` includes thinking tokens and is kept verbatim), or
  `undefined` when none is reported. `CombineResult.usage` (a `CombineUsage`
  with `total` plus a per-participant `byParticipant` breakdown) aggregates every
  model call a combine makes — drafts, critiques, synthesis, and the sanitize
  pass for consensus; every stage plus sanitize for pipeline — so the true,
  several-times-one-call cost of a combine is visible.
- `CompletionRequest.signal` (`AbortSignal`) — timeout/cancellation support.
  Forwarded to every provider `fetch` (both `complete()` and `stream()`) and
  threaded through `combine()` (it extends `CompletionRequest`), so one signal
  cancels every participant call at once. Use `AbortSignal.timeout(ms)` for a
  timeout; an aborted call rejects with a transport `ProviderError`.
- `ProviderRegistry` (`src/registry.ts`) — the package's single point of access
  to its providers. You configure it with `{ anthropic?, openai?, google? }`
  (each a provider options object with `apiKey` and optional `model`/`baseUrl`);
  the
  library constructs the configured providers internally by name. `select(name)`
  returns the provider (typed to the known names) or throws — listing the
  configured names — if it wasn't configured; plus `has(name)` and `names()`.
  The concrete provider classes are intentionally **not** exported.
- Anthropic (Claude) provider behind the registry, talking to the Anthropic
  Messages API directly over the global `fetch` — no SDK dependency. Supports
  `complete()` (full text) and `stream()` (text deltas via SSE). Default model
  `claude-opus-4-8`.
- OpenAI provider behind the registry, talking to the OpenAI Chat Completions
  API directly over the global `fetch` — no SDK dependency. Same `Provider`
  contract: `complete()` and `stream()` (SSE, terminated by `data: [DONE]`).
  Default model `gpt-4.1`; folds the optional `system` prompt into a leading
  `system` message and sends the token cap as `max_completion_tokens`.
- Google provider (`google`) behind the registry, talking to the Gemini
  Generative Language API directly over the global `fetch` — no SDK dependency.
  Same `Provider` contract: `complete()` and `stream()` (SSE via
  `:streamGenerateContent?alt=sse`). Configured via `google` (options type
  `GoogleProviderOptions`); the registry key is the company name, consistent with
  `anthropic`/`openai`, while the model/API it speaks is Gemini.
  Default model `gemini-2.5-pro`; auth via the `x-goog-api-key` header; maps the
  `assistant` role to Gemini's `model`, wraps text in `parts`, carries the
  optional `system` prompt as `systemInstruction`, and sends the token cap as
  `generationConfig.maxOutputTokens`. Note: Gemini 2.5 are thinking models, so
  thinking tokens count against `maxTokens` — a very small cap can leave the
  visible answer empty/truncated (documented in the README).
- `ProviderError` (exported) — a typed error every provider throws, carrying
  `provider`, a `kind` discriminant (`"api"` for an error HTTP response vs
  `"transport"` for a request that never landed), `status` (for `"api"`), and a
  `code`/`type` parsed from the provider's error body. Raw `fetch` rejections
  (network/DNS/abort) are wrapped as `kind: "transport"` instead of escaping as a
  bare `TypeError`. Consumers can branch on `err.status` / `err.kind` instead of
  regex-matching the message. A failed participant's `error` in a `combine()`
  result is a `ProviderError` too. `complete()` now also throws a `ProviderError`
  when a provider/proxy returns HTTP 200 with an `{ error }` body (previously a
  silent empty result).
- Automatic retry with bounded exponential backoff on the routine retryable
  statuses (429 rate limit, 503 unavailable, 529 Anthropic overloaded), for both
  `complete()` and `stream()` across all three providers. Honors a `Retry-After`
  response header when present; the backoff wait respects the request's
  `AbortSignal`. Configurable per provider via a `retry` option
  (`{ maxRetries?, baseDelayMs? }`, exported as `RetryOptions`); defaults to 2
  retries from a 500ms base. Set `maxRetries: 0` to disable. Transport failures
  (no response) are not retried.
- Robust SSE parsing across all three providers' `stream()`: blank or malformed
  `data:` lines are tolerated (empty payloads skipped, each `JSON.parse` guarded
  so a bad frame is dropped rather than stranding tokens already yielded).
- `stream()` releases the response body reader on every exit path (normal end,
  thrown error, or a consumer `break`ing out of the `for await`) via
  `try/finally { await reader.cancel(); }`, so a long-running server can't leak a
  socket.
- `ProviderRegistry.combine()` — combine multiple configured providers to
  cooperate on one prompt using a strategy. The first strategy is **consensus**:
  every participant drafts an answer in parallel, then every participant
  critiques all drafts, then a designated synthesizer writes the final answer.
  Participants are picked by name (validated like `select()`); the synthesizer
  defaults to the first participant; drafts are attributed by provider name by
  default (`attribution: "anonymized"` opts out). Partial failures are tolerated
  (participants that fail or return empty-text drafts are recorded and dropped,
  the round proceeds with the survivors down to `minParticipants`, default 2; a
  synthesizer that fails or
  returns empty text falls back to the next survivor); a single participant
  degrades to a plain completion. Requests are validated up front (non-empty,
  unique participants; non-empty messages; positive `minParticipants` ≤ the
  participant count; a participant synthesizer; a known strategy). The draft and
  critique phases (the messages passed between providers) are instructed to omit
  greetings, sign-offs, and preamble to save tokens; the user-facing synthesis is
  not constrained.
- Tuned consensus behaviour for answer quality: the draft/critique conciseness
  directive now keeps reasoning, assumptions, and caveats (only ceremony is
  stripped) so critics can check the _why_; drafts are **anonymized** to the
  other providers by default (`Answer A/B/C` — opt out with
  `attribution: "attributed"`; the result still carries provider names) to
  reduce brand and self-preference bias; each critique now ends with a structured
  verdict (best answer / key fix / confidence); and the synthesizer is instructed
  to adjudicate on correctness over popularity, not favour its own (now
  unidentifiable) draft, surface unresolved disagreement rather than blend it
  away. The synthesis is framed so the drafts/critiques are private input
  material and the final answer is written as if answering the user fresh — it
  never alludes to the drafts, critiques, selection process, or internal labels
  like `Answer A` (the internal draft heading is `## Drafts`, not
  `## Candidate answers`, to keep that word out of the model's context).
  Prompt instructions proved unreliable at suppressing that narration, so a final
  **sanitizing pass** rewrites the synthesized answer to strip any leftover
  meta-commentary about the process — one extra model call per combine; on
  failure or empty output it returns the un-sanitized answer.
- `combine()` accepts an optional `CombineOptions` second argument with an
  `onEvent` callback for progress events (`CombineEvent`: phase boundaries and
  per-participant `draft`/`critique` settle events with `ok`/`failed` status).
  Status only — no token streaming; the result is still the resolved
  `CombineResult`. Handler errors are swallowed so a listener can't break the run.
  New types `CombineRequest`, `CombineResult`, `ParticipantOutcome`, and
  `StrategyName` (in `src/combine/`) are exported from the entry point. Uses
  only `complete()` — no streaming for combine yet.
- Second combine strategy, **pipeline** (`strategy: "pipeline"`) — a conveyor
  belt of providers that refine one answer in sequence. The first participant
  writes an initial answer; each later participant receives the question plus the
  current running answer and improves it (the refine framing treats the current
  answer as a strong baseline to preserve, since there is no downstream
  synthesizer to catch a regression); the last stage to produce an answer is the
  final answer. `participants` order is the conveyor order. A failed or
  empty-output stage is recorded and the previous answer carries forward; the run
  fails only if no stage produces an answer. When a refining stage actually
  changed the answer it gets the same sanitizing pass as consensus to strip
  process narration (skipped for a first-stage answer or an unchanged
  passthrough, so the extra call only runs when it can matter). `synthesizer`,
  `attribution`, and `minParticipants` are consensus-specific — validated and
  applied only on the consensus path, ignored by pipeline. The strategy emits
  `stage` progress events (provider, status, 0-based `index`).
- **Breaking:** `CombineResult` is now a union discriminated on `strategy` —
  `ConsensusResult` (`synthesizer`, `drafts`, `critiques`) and `PipelineResult`
  (`finalProvider`, `stages`). Narrow on `result.strategy` to reach the
  strategy-specific fields. New types `ConsensusResult` and `PipelineResult` are
  exported; `CombineEvent` gains the `stage` variant.
- Mocked unit tests for request building, SSE parsing, and error handling.
- Opt-in live integration tests (`*.integration.test.ts`), double-gated on
  `RUN_LIVE_TESTS=1` + the provider key
  (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`). The consensus
  combine suites (`consensus.integration`, `pipeline.integration`) are
  triple-gated, requiring all three keys (they run the full three-way flow).
  The `test:integration` script runs all integration suites by default and
  accepts an optional filename pattern to narrow to one provider
  (e.g. `yarn test:integration openai.integration`).
- Local `.env` support for tests: loaded via `dotenv` in `jest.setup.cjs`, with
  a committed `.env.example` template (`.env` is gitignored). The library itself
  never reads environment variables.
- `@types/node` dependency and `"types": ["node"]` in `tsconfig.json` so Node
  globals (`fetch`, `ReadableStream`, `TextDecoder`) resolve.
- `README.md`, expanded with a table of contents, an error-handling section
  (how `complete()`/`stream()` surface API failures), status/TypeScript/Node
  badges, and a changelog link.
- MIT `LICENSE` and a `package.json` `description`.
