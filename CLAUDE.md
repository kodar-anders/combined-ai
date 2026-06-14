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

A **plain TypeScript library** meant to be imported by other projects. Its purpose is to **combine several AI services/providers into one package** — selecting a single provider for a prompt, and (later) combining multiple providers on one prompt. `src/index.ts` is the public entry point — re-export the package's public API from there. The foundations (build, test, lint, type-check) are in place and three providers (Anthropic, OpenAI, Gemini) are implemented.

### Library structure (current)

- `src/types.ts` — the provider-agnostic contract every provider implements: `Message`, `CompletionRequest`, `CompletionResult`, and `Provider` (`complete()` → full text, `stream()` → `AsyncIterable<string>` of text deltas).
- `src/providers/anthropic.ts` — `AnthropicProvider`, talking to the Anthropic Messages API (`POST /v1/messages`) directly over the global `fetch` — **no SDK dependency**. Default model `claude-opus-4-8`. Streaming parses the SSE body and yields `content_block_delta` → `text_delta` text. The request body is kept minimal (no `temperature`/`top_p`/`top_k`/`thinking` — Opus 4.x rejects sampling params).
- `src/providers/openai.ts` — `OpenAIProvider`, talking to the OpenAI Chat Completions API (`POST /v1/chat/completions`) directly over `fetch` — **no SDK dependency**. Default model `gpt-4.1`. Auth via `Authorization: Bearer`. The optional `system` prompt is folded into a leading `{ role: "system" }` message (OpenAI has no top-level system field), and the token cap is sent as `max_completion_tokens` (works on the o-series too). Streaming parses SSE, yields `choices[0].delta.content`, and stops on the `data: [DONE]` sentinel.
- `src/providers/gemini.ts` — `GeminiProvider`, talking to the Google Generative Language API (`POST /v1beta/models/{model}:generateContent`, streaming via `:streamGenerateContent?alt=sse`) directly over `fetch` — **no SDK dependency**. Default model `gemini-2.5-pro`. Auth via the `x-goog-api-key` header. The model and action live in the URL path (not the body); the `assistant` role is mapped to Gemini's `model`, message text is wrapped as `parts: [{ text }]`, the optional `system` prompt is sent as a top-level `systemInstruction`, and the token cap is sent as `generationConfig.maxOutputTokens`. `complete()` concatenates `candidates[0].content.parts[].text` and reads the actual model from `modelVersion`; streaming parses SSE and yields the same text from each chunk. **Thinking-token gotcha:** Gemini 2.5 are thinking models and their thinking tokens count against `maxTokens` (`maxOutputTokens`), so a tiny cap can be fully consumed by thinking and return empty/truncated text (unlike Anthropic/OpenAI where `maxTokens` budgets only visible output). We deliberately do **not** disable thinking — the default `gemini-2.5-pro` can't fully disable it — so the live test uses a generous `maxTokens` (512) and the behavior is documented in the README rather than worked around in code.
- `src/registry.ts` — `ProviderRegistry`, the package's **single point of access** to its providers. The provider classes are **not exported**; the registry constructs the built-ins by name from a config object. Constructor takes `ProviderRegistryConfig` (`{ anthropic?: AnthropicProviderOptions; openai?: OpenAIProviderOptions; gemini?: GeminiProviderOptions }`) and constructs only the providers present. `select(name)` is typed to `ProviderName` (`"anthropic" | "openai" | "gemini"`) and returns the `Provider` or throws an `Error` listing the configured names; plus `has(name: string)` and `names()` (fixed order: anthropic, openai, gemini). It never reads env vars — keys come from the config. Groundwork for the step-4 combine feature.
- New providers: add `src/providers/<name>.ts` implementing `Provider`, then wire it into `ProviderRegistry` (a new optional field on `ProviderRegistryConfig` + a construction branch). The provider class itself stays internal — only `index.ts` re-exports its **options type** and the registry handles construction. `index.ts` is the single public entry point; do not export provider classes.
- Tests live in a `__tests__/` folder **colocated** with the code under test — provider tests are in `src/providers/__tests__/` (import via `../<provider>`), and `src/`-level code like `registry.ts` is tested in `src/__tests__/` (import via `../registry`). The convention is one `__tests__/` per source folder, as close to the files under test as possible. Each provider has `<provider>.test.ts` (mocked unit tests) and `<provider>.integration.test.ts` (live, opt-in). Keep the `.test.ts` / `.integration.test.ts` suffix (the latter so the `test:integration` pattern filter matches them).

## Commands

- `yarn build` — bundle `src/index.ts` to `dist/` via **tsup** as dual ESM (`index.js`) + CJS (`index.cjs`) with `.d.ts`/`.d.cts` declarations and sourcemaps.
- `yarn typecheck` — `tsc --noEmit`. tsc is type-check only; tsup owns the build.
- `yarn test` — Jest. Single test: `yarn test <pattern>` or `yarn test -t "<name>"`. Watch: `yarn test:watch`.
- `yarn test:integration` — **live** API tests (`*.integration.test.ts`). Double-gated per provider: a suite runs only when both `RUN_LIVE_TESTS=1` (the script sets it) and that provider's key are present (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`); otherwise it's `describe.skip`, so plain `yarn test` always skips it and never makes a paid call. Live tests use the cheap model per provider (`claude-haiku-4-5` / `gpt-4.1-mini` / `gemini-2.5-flash`) with a small `maxTokens` to keep cost negligible (Gemini uses 512 rather than ~16 to leave room for its thinking tokens — see the Gemini structure note). The script (`RUN_LIVE_TESTS=1 sh -c 'jest ${1:-integration}' --`) defaults to all integration tests; append a Jest filename pattern to narrow to one provider — `yarn test:integration openai.integration` (the appended pattern **replaces** the `integration` default rather than OR-ing with it, which is the point of the `sh -c` wrapper).
  - **Env loading:** `jest.setup.cjs` (wired via `setupFiles` in `jest.config.mjs`) loads a gitignored `.env` via `dotenv` so the key is picked up automatically. Copy `.env.example` → `.env` and paste your `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`. **Only the tests read env** — the library itself never reads env vars; consumers always pass `apiKey` to the provider explicitly.
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
