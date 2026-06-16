# CLAUDE.md

## Agent instructions (read first)

- Don't over-engineer: no abstractions for hypothetical needs, no unrelated refactors while fixing, prefer 2–3x inline duplication over a premature helper.
- **Never add `Co-Authored-By: Claude`** or any AI-attribution trailer to commits.
- **Edit loop (run as you go, not at "done"):** after editing a file, run `yarn eslint <path>` (not the full `yarn lint`), `yarn typecheck`, and prettier on it. If the file is covered by Jest tests, run them (`yarn test path/to/file.test.ts`) before declaring done.
- Keep `CLAUDE.md` updated and **compact** — it's instructions, not docs. Record only what an agent can't infer from code (commands, conventions, gotchas, decisions); point to files rather than restate their types. When you add a line, delete or compress a stale one.
- Keep `README.md`/`CHANGELOG.md` current. Unshipped changes go under `## [Unreleased]` (Keep a Changelog format). Add a dated version heading only at release time: rename `## [Unreleased]` → `## [<version>] - <date>` and put a fresh empty `## [Unreleased]` above it. Categorize (`### Added`/`### Changed`/`### Fixed`) against the last published version — before the first release, everything is `### Added`.
- Don't run integration tests unless asked — they make live, **paid** API calls.
- Per-developer instructions live in a gitignored `CLAUDE.local.md` (loads after this file). Keep this file to project-wide facts.

## What this is

A **plain TypeScript library** that combines several AI providers into one package — pick one provider for a prompt, or combine many via a strategy. `src/index.ts` is the only public entry point; re-export the public API there (provider classes stay internal). Three providers: Anthropic, OpenAI, Google. The `"google"` provider speaks the **Gemini** API — registry key/`name` is `"google"` (the company, like `anthropic`/`openai`); internal `toGemini*` helpers and the `gemini-2.5-pro` default keep the Gemini name (the API it talks to).

## Core contracts — `src/types.ts`

The provider-agnostic contract: `Message`, `CompletionRequest`, `CompletionResult`, `Provider` (`complete()` → text, `stream()` → `AsyncIterable<string>` deltas). Points an agent can't infer:

- `Message.content` is `string | ContentPart[]` (string = one text part). `ContentPart` union: text/image/file/`tool_use`/`tool_result`. `MediaSource` = base64 (carries mediaType) | url (optional mediaType). **Intended compile seam:** adding a `ContentPart` member breaks every provider `to*Part` mapper and `textOf` in `combine/shared.ts` until handled. **Provider support varies — mappers throw when unsupported.**
- `complete()`-only result fields, all optional + set only when present (so `toEqual({text,model})` tests still pass): `finishReason` (normalized `stop|length|content_filter|tool_use|other`) + `rawFinishReason`; `refusal` (forces `content_filter`); `usage` (`{inputTokens,outputTokens,totalTokens}`); `parsed`; `toolCalls`. New code building a `CompletionResult` should keep these.
- `signal?: AbortSignal` forwards to every provider `fetch`; combine threads one signal through all participant calls.
- **Structured output:** `responseFormat?: {type:"json_schema", schema, name?}` — raw JSON Schema (no Zod; locked choice). Affects `complete()` and `stream()`; `complete()` also returns `parsed` (= `JSON.parse(text)`, undefined on invalid/truncated). **Cross-provider schema rules** (driven by OpenAI strict + Gemini's limited keywords): every object needs `additionalProperties:false` + all props `required` with a single non-null type; avoid optional/nullable, recursive, `$ref`, numeric/length constraints (`toGeminiSchema` doesn't translate null-unions).
- **Tool calling (single-provider only):** `tools?` + `toolChoice?` (`auto|any|none|{name}`); replay results with `tool_use`/`tool_result` parts. **`combine` rejects tools/toolChoice.** Replay rules: OpenAI throws without `tool_use.id`/`tool_result.toolUseId`; Gemini throws without `tool_result.name`; Anthropic hoists `tool_result` blocks first.

## Errors & transport

- `src/errors.ts` — error vocabulary. `ProviderError` (exported), `kind`: `"api"` (non-2xx → `status` set, via `apiError`) | `"transport"` (`fetch` rejected → `cause` set). `apiErrorFromBody` handles a 2xx body carrying `{error}` (so it throws instead of returning `text:""`). **Imports `ProviderName` from `./registry` type-only** (no runtime cycle — keep it that way). Mid-stream SSE errors stay plain `Error`. Also `aggregateError(message, causes)` (→ `AggregateError` or plain `Error`); combine's `noResultError` adapts it. No fetch/transport code here.
- `src/transport.ts` — `requestWithRetry(provider, input, init, retry?)`: bounded exponential backoff on 429/503/529, honors `Retry-After` (capped 60s), aborts early on `signal`. **Transport rejections aren't retried.** Config via per-provider `retry?: RetryOptions` (`{maxRetries?, baseDelayMs?}`, defaults 2/500ms, `0` disables). Per-`complete()` call, so combine benefits transparently.

## Providers — `src/providers/`

All talk to their HTTP API directly over `fetch` — **no SDK dependency**. Each maps `Message.content` per-wire, normalizes `finishReason`/`usage`, supports structured output + tools. Class stays internal; `index.ts` re-exports only the options type. Gotchas:

- `anthropic.ts` — Messages API, default `claude-opus-4-8`. **Body kept minimal — Opus 4.x rejects `temperature`/`top_p`/`top_k`/`thinking`.** `refusal` collected from `type:"refusal"` blocks; hoists `tool_result` blocks first.
- `openai.ts` — Chat Completions, default `gpt-4.1`. `system` folded into a leading system message; cap sent as `max_completion_tokens`. `OpenAIProviderOptions.headers?` spread last (override defaults) — for gateways/OpenAI-compatible. Constructor's 2nd arg `name` (internal, registry-only) attributes errors to a custom alias. **URL file source throws** (Chat Completions has none); tool-call `arguments` is a JSON string (parsed on the way out).
- `google.ts` — Gemini API (`GoogleProviderOptions`), default `gemini-2.5-pro`. Model+action in the URL path; `assistant`→`model`; `system`→`systemInstruction`; cap→`maxOutputTokens`. **Thinking-token gotcha: Gemini 2.5 thinking tokens count against `maxOutputTokens`, so a tiny cap returns empty/truncated text — give it a generous cap.** **`fileData.fileUri` accepts only a Files API/`gs://` URI, not a public web URL.** `toGeminiSchema` UPPERCASEs `type` (structured output + tool params); finishReason overridden to `tool_use` only on a clean stop; no `refusal` field.
- Shared helpers: `extract.ts` (`extractModel`, exported `isRecord`), `structured.ts` (`parseStructured`), `sse.ts` (`sseJson(body)` — shared SSE reader: yields parsed `data:` JSON objects, ends on `[DONE]`, always releases the reader; each `stream()` for-awaits it and handles its own events/errors). `toArray` stays duplicated per-provider (trivial). `errors.ts`/`transport.ts` keep their own `isRecord` (lower layer).
- **Adding a provider:** new `src/providers/<name>.ts` implementing `Provider`; add an optional field to `ProviderRegistryConfig` + a construction branch in the registry; re-export its options type from `index.ts`.

## Registry — `src/registry.ts`

`ProviderRegistry` is the **single point of access**; provider classes aren't exported. Constructor takes `ProviderRegistryConfig` (`{anthropic?, openai?, google?, custom?}`) and builds only what's present. **Never reads env** — keys come from config.

- `select(name)` → `Provider` or throws (lists configured names); `has(name)`, `names()` (built-ins first in fixed order, then custom in definition order).
- `custom?: Record<string, CustomProviderConfig>` — `{kind:"openai-compatible", apiKey, baseUrl, model, headers?, retry?}` (OpenRouter/Together/Groq/Ollama/local; `baseUrl` excludes the request path) | `{kind:"provider", provider}` (BYO). A custom name colliding with a built-in throws.
- `ProviderName = BuiltInProviderName | (string & Record<never,never>)` (autocomplete trick; `Record<never,never>` satisfies `no-empty-object-type`) — custom names accepted everywhere, built-ins still autocomplete.
- **Combine API:** four per-strategy methods (`consensus`/`pipeline`/`ensemble`/`broadcast`, each returns its concrete `…Result`) + generic `combine(request)` dispatching on `request.strategy ?? "consensus"`. `combine<S extends StrategyName>` infers `S` from the `strategy?: S` discriminant → concrete `ResultFor<S>` for a literal strategy, full union otherwise. (Don't type the param as `StrategyRequest<S>` — TS can't infer through indexed-access on object literals.)
- Validation: shared `#prepare` normalizes each `ParticipantSpec` (throws on a falsy `model`/`maxTokens` override), enforces ≥1 participant + unique ids + non-empty messages, rejects tools/toolChoice, resolves the roster. Per-strategy: consensus/pipeline/broadcast reject `responseFormat` (ensemble-only); consensus validates `minParticipants`/`synthesizer`; ensemble requires `responseFormat` with an object root.

## Combine — `src/combine/`

Make multiple providers cooperate on one prompt via a selectable strategy. **One file per strategy.** Entry is `ProviderRegistry.combine`; each orchestrator is internal (the registry imports it). No streaming in combine yet.

- `index.ts` — public barrel: combine types + the one runtime value `STRATEGY_NAMES` (source of truth `combine()` validates). `CombineResult` discriminated on `strategy` (`BroadcastResult` has **no `text`**). `ParticipantSpec = ProviderName | {provider, model?, maxTokens?, label?}` with a unique **id** (label, defaults to provider or `<provider>-<model>`); `synthesizer` is an id. Results carry `usage?: CombineUsage` keyed by id. **Imports `ProviderName` type-only** (keep the combine↔registry cycle erasable).
- `shared.ts` — helpers reused by ≥2 strategies (`completionFor`, `composeSystem`, `runOutcome`, `respondAll`, `noResultError`, `sanitizeAnswer`, `makeEmitter`, `aggregateUsage`, `RosterEntry`, …). `completionFor`/`sanitizeAnswer` take per-participant overrides that beat the request-wide `model`/`maxTokens`; strategies pass the entry itself. A helper lands here only once a 2nd strategy reuses it (2–3x rule).
- **consensus** — draft (parallel) → critique (each survivor critiques all drafts, anonymized unless `attribution:"attributed"`) → synthesize (by `synthesizer` id) + a sanitizing pass. **Framing invariants (preserve — rationale in doc-comments):** `SYNTH_FRAMING` adjudicates on correctness over popularity and forbids alluding to drafts/critiques/labels; `sanitizeAnswer` strips leftover process narration (one extra `complete()` call, multi-provider only); `CONCISE_DIRECTIVE` strips ceremony but keeps reasoning/caveats. Survivor policy: empty drafts dropped; 0 → throw; single-provider → plain completion; `< minParticipants` (default 2) → throw; failed critiques non-fatal; failed synthesizer falls back to next survivor.
- **pipeline** — sequential refinement; participant order = conveyor order. First stage drafts, later stages refine the running answer; a stage advances only if `ok` + non-empty; final = last advancing stage. Throws only if none advanced. Sanitize runs only when a refiner actually changed the text. No `minParticipants`/`synthesizer`/`attribution`.
- **ensemble** — multi-model vote on structured output (the differentiator). Every participant answers under the same `responseFormat` in parallel; only `ok` responses with a plain-object `parsed` count. **Mechanical merge (no LLM):** field-wise majority vote over the first-seen key union (mode by deep-equality, first-seen wins ties) so merged values are real. `agreement` denominator = all valid responses (omitted fields score low). Object-root only; nested merge is shallow. (`stableKey` uses `.sort()` not `toSorted` — ES2022 lib lacks it.)
- **broadcast** — fan-out, **no combine**: every participant answers the verbatim prompt in parallel (no framing/sanitize), returns all responses, no `text`. Throws only if zero succeed (empty `ok` still counts). Rejects `responseFormat`.
- **Test coupling (gotcha):** consensus/pipeline tests classify the phase by literal markers in the framing constants — `"Rewrite the following"` (sanitize), `"lead assistant"` (synth), `"produce only a critique"` (critique), `"revise the current answer"` (pipeline refine). Keep each constant free of the others' markers.
- **`noUncheckedIndexedAccess` gotcha:** don't zip parallel arrays by index — carry paired data in one structure (roster / running answer).
- **Adding a strategy:** new `src/combine/<strategy>.ts` exporting its orchestrator; add to `STRATEGY_NAMES`/`StrategyName`, a `<Strategy>Request`, a `…Result` member, and a `StrategyRequest` entry in `index.ts`; add a public method + a `combine()` `case` in the registry. Promote a helper to `shared.ts` only on actual reuse.

## Tests

- Colocated `__tests__/` per source folder: `src/providers/__tests__/`, `src/combine/__tests__/`, `src/__tests__/` (registry, transport). Import via `../<file>` / `../../<file>`.
- Each provider has `<provider>.test.ts` (mocked) + `<provider>.integration.test.ts` (live, opt-in — keep the suffix so the `test:integration` filter matches).
- Combine unit tests use network-free fake `Provider`s (no `fetch` mock); registry-level `combine()` validation lives in `src/__tests__/registry.test.ts`.

## Commands

- `yarn build` — tsup bundles `src/index.ts` to dual ESM+CJS with declarations + sourcemaps.
- `yarn typecheck` — `tsc --noEmit` (type-check only; tsup owns the build).
- `yarn test` — Jest. Single: `yarn test <pattern>` or `-t "<name>"`. `yarn test:watch`.
- `yarn test:integration` — **live, paid** tests. Double-gated per provider: needs `RUN_LIVE_TESTS=1` (the script sets it) + that provider's key (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`), else `describe.skip`. Cheap models (`claude-haiku-4-5`/`gpt-4.1-mini`/`gemini-2.5-flash`), small `maxTokens` (Gemini bigger for thinking tokens). Append a filename pattern to narrow (replaces the default). Env loads from a gitignored `.env` via `jest.setup.cjs`/dotenv (copy `.env.example`). **Only tests read env — the library never does.**
- `yarn lint` / `yarn lint:fix`, `yarn format` / `yarn format:check`.

## Toolchain & conventions

- **Build = tsup, type-check = tsc** (`noEmit: true`). Tests run through **`@swc/jest`** (no type-checking — that's `yarn typecheck`); test files import globals from `@jest/globals`. Dual-format packaging via `package.json` `exports`; `prepack` builds. Node globals typed via `@types/node` + `"types":["node"]` (makes `fetch`/`Response`/`ReadableStream` resolve under the ES2022 lib).
- **Yarn 4 (Berry) PnP** — no `node_modules`; always `yarn`, never `npm`. **PnP gotcha:** can only import deps declared directly in `package.json` (why `@jest/globals` is an explicit devDep). `@jest/globals` version lags `jest` — match what Jest pulls. `tsconfig` sets `ignoreDeprecations:"6.0"` for tsup's `.d.ts` `baseUrl`.
- **Lint** (`eslint.config.mjs`, flat, type-aware + unicorn + promise; Jest rules in tests only): `type` over `interface`; inline `import type` + `consistent-type-exports`; exported API needs explicit types/return types; `no-console: error` (off in tests); `_`-prefix unused args; single-line `case` omits braces; Prettier owns formatting.
- `"private": true` in `package.json` — flip to publish (packaging fields already work for git/workspace installs).
