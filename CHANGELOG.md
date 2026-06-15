# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core, provider-agnostic contract in `src/types.ts`: `Provider`, `Message`,
  `Role`, `CompletionRequest`, `CompletionResult`.
- `ProviderRegistry` (`src/registry.ts`) — the package's single point of access
  to its providers. You configure it with `{ anthropic?, openai?, gemini? }`
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
- Google Gemini provider behind the registry, talking to the Generative Language
  API directly over the global `fetch` — no SDK dependency. Same `Provider`
  contract: `complete()` and `stream()` (SSE via `:streamGenerateContent?alt=sse`).
  Default model `gemini-2.5-pro`; auth via the `x-goog-api-key` header; maps the
  `assistant` role to Gemini's `model`, wraps text in `parts`, carries the
  optional `system` prompt as `systemInstruction`, and sends the token cap as
  `generationConfig.maxOutputTokens`. Note: Gemini 2.5 are thinking models, so
  thinking tokens count against `maxTokens` — a very small cap can leave the
  visible answer empty/truncated (documented in the README).
- `ProviderRegistry.combine()` — combine multiple configured providers to
  cooperate on one prompt using a strategy. The first strategy is **consensus**:
  every participant drafts an answer in parallel, then every participant
  critiques all drafts, then a designated synthesizer writes the final answer.
  Participants are picked by name (validated like `select()`); the synthesizer
  defaults to the first participant; drafts are attributed by provider name by
  default (`attribution: "anonymized"` opts out). Partial failures are tolerated
  (failed participants are recorded and dropped, the round proceeds with the
  survivors down to `minParticipants`, default 2; a synthesizer that fails or
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
