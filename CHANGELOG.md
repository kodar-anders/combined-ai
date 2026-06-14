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
- Mocked unit tests for request building, SSE parsing, and error handling.
- Opt-in live integration tests (`*.integration.test.ts`), double-gated on
  `RUN_LIVE_TESTS=1` + the provider key
  (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`).
  The `test:integration` script runs all integration suites by default and
  accepts an optional filename pattern to narrow to one provider
  (e.g. `yarn test:integration openai.integration`).
- Local `.env` support for tests: loaded via `dotenv` in `jest.setup.cjs`, with
  a committed `.env.example` template (`.env` is gitignored). The library itself
  never reads environment variables.
- `@types/node` dependency and `"types": ["node"]` in `tsconfig.json` so Node
  globals (`fetch`, `ReadableStream`, `TextDecoder`) resolve.
- `README.md`.

### Removed

- Placeholder `version` constant and its test (scaffolding).
