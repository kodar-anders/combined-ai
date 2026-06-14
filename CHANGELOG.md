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
- Mocked unit tests for request building, SSE parsing, and error handling.
- Opt-in live integration tests (`*.integration.test.ts`), double-gated on
  `RUN_LIVE_TESTS=1` + `ANTHROPIC_API_KEY`, plus a `test:integration` script.
- Local `.env` support for tests: loaded via `dotenv` in `jest.setup.cjs`, with
  a committed `.env.example` template (`.env` is gitignored). The library itself
  never reads environment variables.
- `@types/node` dependency and `"types": ["node"]` in `tsconfig.json` so Node
  globals (`fetch`, `ReadableStream`, `TextDecoder`) resolve.
- `README.md`.

### Removed

- Placeholder `version` constant and its test (scaffolding).
