# CLAUDE.md

## Agent instructions (read first)

- If you are unsure about something, ask me first.
- Don't over-engineer. Concretely: no abstractions for hypothetical needs, no unrelated refactors while making a fix, prefer 2–3x inline duplication over a premature helper.
- Only commit when I explicitly ask.
- **Never add `Co-Authored-By: Claude`** or any AI attribution trailer to commit messages.
- Use the `gh` CLI for all GitHub operations — never MCP GitHub tools. Don't open, close, merge, or edit PRs/issues.
- After editing any file, always run `yarn eslint <path>` on the changed file(s) and `yarn typecheck`. Also run
  prettier on the change file(s). Don't skip either, and don't wait until "done" — run them as part of the edit loop. If any of the edited files are covered by Jest tests, also run those specific tests (`yarn jest path/to/file.spec.tsx`) before declaring the task done. Use `yarn eslint <path>` rather than the full-project `yarn lint`.
- Always update `CLAUDE.md` whenever you make any change that might affect the agent's behavior, or when you make a
  change that you think should be documented. Basically, try to always keep `CLAUDE.md` up-to-date with the project.
- Always ask if you should update `CLAUDE.md` when you get instructions that you think could be good to add to it.
- Keep `README.md` and `CHANGELOG.md` up to date. For the readme file: record notable changes under the `## 
[Unreleased]` section (Keep a Changelog format). `README.md` and `CHANGELOG.md` exist at the project root.

## What this is

A **plain TypeScript library** meant to be imported by other projects. Its purpose is to **combine several AI services/providers into one package** — selecting a single provider for a prompt, and (later) combining multiple providers on one prompt. `src/index.ts` is the public entry point — re-export the package's public API from there. The foundations (build, test, lint, type-check) are in place and two providers (Anthropic, OpenAI) are implemented.

### Library structure (current)

- `src/types.ts` — the provider-agnostic contract every provider implements: `Message`, `CompletionRequest`, `CompletionResult`, and `Provider` (`complete()` → full text, `stream()` → `AsyncIterable<string>` of text deltas).
- `src/providers/anthropic.ts` — `AnthropicProvider`, talking to the Anthropic Messages API (`POST /v1/messages`) directly over the global `fetch` — **no SDK dependency**. Default model `claude-opus-4-8`. Streaming parses the SSE body and yields `content_block_delta` → `text_delta` text. The request body is kept minimal (no `temperature`/`top_p`/`top_k`/`thinking` — Opus 4.x rejects sampling params).
- `src/providers/openai.ts` — `OpenAIProvider`, talking to the OpenAI Chat Completions API (`POST /v1/chat/completions`) directly over `fetch` — **no SDK dependency**. Default model `gpt-4.1`. Auth via `Authorization: Bearer`. The optional `system` prompt is folded into a leading `{ role: "system" }` message (OpenAI has no top-level system field), and the token cap is sent as `max_completion_tokens` (works on the o-series too). Streaming parses SSE, yields `choices[0].delta.content`, and stops on the `data: [DONE]` sentinel.
- New providers go under `src/providers/` and implement `Provider`; export them from `src/index.ts`.
- Tests live in a `__tests__/` folder **colocated** with the code under test — provider tests are in `src/providers/__tests__/` and import via `../<provider>`. The convention is one `__tests__/` per source folder, as close to the files under test as possible (so other folders get their own `__tests__/` later). Each provider has `<provider>.test.ts` (mocked unit tests) and `<provider>.integration.test.ts` (live, opt-in). Keep the `.test.ts` / `.integration.test.ts` suffix (the latter so the `test:integration` pattern filter matches them).

## Commands

- `yarn build` — bundle `src/index.ts` to `dist/` via **tsup** as dual ESM (`index.js`) + CJS (`index.cjs`) with `.d.ts`/`.d.cts` declarations and sourcemaps.
- `yarn typecheck` — `tsc --noEmit`. tsc is type-check only; tsup owns the build.
- `yarn test` — Jest. Single test: `yarn test <pattern>` or `yarn test -t "<name>"`. Watch: `yarn test:watch`.
- `yarn test:integration` — **live** API tests (`*.integration.test.ts`). Double-gated per provider: a suite runs only when both `RUN_LIVE_TESTS=1` (the script sets it) and that provider's key are present (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`); otherwise it's `describe.skip`, so plain `yarn test` always skips it and never makes a paid call. Live tests use the cheap model per provider (`claude-haiku-4-5` / `gpt-4.1-mini`) with a tiny `maxTokens` to keep cost negligible. The script (`RUN_LIVE_TESTS=1 sh -c 'jest ${1:-integration}' --`) defaults to all integration tests; append a Jest filename pattern to narrow to one provider — `yarn test:integration openai.integration` (the appended pattern **replaces** the `integration` default rather than OR-ing with it, which is the point of the `sh -c` wrapper).
  - **Env loading:** `jest.setup.cjs` (wired via `setupFiles` in `jest.config.mjs`) loads a gitignored `.env` via `dotenv` so the key is picked up automatically. Copy `.env.example` → `.env` and paste your `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. **Only the tests read env** — the library itself never reads env vars; consumers always pass `apiKey` to the provider explicitly.
- `yarn lint` / `yarn lint:fix` — ESLint.
- `yarn format` / `yarn format:check` — Prettier.

## Architecture / toolchain choices

- **Build = tsup, type-check = tsc.** tsconfig has `noEmit: true`; it exists for editor IntelliSense and `yarn typecheck` only. The build settings live in the `tsup` flags in `package.json`'s `build` script.
- **Tests run through `@swc/jest`** (`jest.config.mjs`), which transpiles TS→CJS fast and does _no_ type-checking — types are covered separately by `yarn typecheck`. Test files import globals explicitly from `@jest/globals` (e.g. `import { describe, it, expect } from "@jest/globals"`) rather than relying on ambient types.
- **Dual-format packaging** is wired in `package.json` via the `exports` map (`import`→`.js`/`.d.ts`, `require`→`.cjs`/`.d.cts`). `files: ["dist"]` and `prepack: yarn build` mean the build is produced on publish/pack.
- **Node globals are typed via `@types/node`** (devDependency), referenced explicitly with `"types": ["node"]` in `tsconfig.json`. This is what makes `fetch`, `Response`, `ReadableStream`, `TextDecoder`, etc. resolve under the ES2022-only `lib` — the provider transport relies on them.

## Package management — Yarn 4 PnP

Uses **Yarn 4 (Berry) with Plug'n'Play** — there is no `node_modules`; deps resolve via `.pnp.cjs` / `.pnp.loader.mjs`. Always use `yarn` (never `npm`).

- **PnP strictness gotcha:** you can only import packages declared directly in `package.json`. A transitive-only dep won't resolve (this is why `@jest/globals` is an explicit devDependency).
- `@jest/globals` versions lag `jest`'s — they are not the same number (jest `30.4.2` ↔ `@jest/globals` `30.4.1`). Match the version Jest actually pulls when bumping.
- `tsconfig` sets `ignoreDeprecations: "6.0"` solely because tsup's `.d.ts` bundler injects a now-deprecated `baseUrl` under TypeScript 6.

## Lint conventions (enforced)

`eslint.config.mjs` is a flat config: type-aware (`strictTypeChecked` + `stylisticTypeChecked`) + unicorn + promise for `**/*.ts`; Jest rules scoped to test files only; a non-type-checked block for `*.{js,cjs,mjs}`. Notable rules:

- **`type` over `interface`**; **`import type`** (inline style) for type-only imports; `consistent-type-exports`.
- Exported API must declare types (`explicit-module-boundary-types`) and functions need return types (`explicit-function-return-type`, callbacks exempt).
- `no-console: error` (a library shouldn't log to a consumer's console) — off in tests.
- Prefix intentionally-unused args with `_`; unused imports are an error.
- Single-line `case` clauses omit braces. Prettier owns formatting (ESLint defers via `eslint-config-prettier`).

## Notes

- `"private": true` in `package.json` — flip to publish to a registry (the packaging fields already work for git/workspace installs).
