# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core, provider-agnostic contract in `src/types.ts`: `Provider`, `Message`,
  `Role`, `CompletionRequest`, `CompletionResult`.
- `AnthropicProvider` (`src/providers/anthropic.ts`) talking to the Anthropic
  Messages API directly over the global `fetch` — no SDK dependency. Supports
  `complete()` (full text) and `stream()` (text deltas via SSE). Default model
  `claude-opus-4-8`.
- `OpenAIProvider` (`src/providers/openai.ts`) talking to the OpenAI Chat
  Completions API directly over the global `fetch` — no SDK dependency. Same
  `Provider` contract as `AnthropicProvider`: `complete()` and `stream()` (SSE,
  terminated by `data: [DONE]`). Default model `gpt-4.1`; folds the optional
  `system` prompt into a leading `system` message and sends the token cap as
  `max_completion_tokens`.
- Mocked unit tests for request building, SSE parsing, and error handling.
- Opt-in live integration tests (`*.integration.test.ts`), double-gated on
  `RUN_LIVE_TESTS=1` + the provider key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
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
