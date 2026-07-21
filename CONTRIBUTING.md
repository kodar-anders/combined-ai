# Contributing to combined-ai

Thanks for your interest in contributing! This library unifies the Anthropic,
OpenAI, and Google (Gemini) APIs behind one provider-agnostic contract and adds
strategies for combining several providers on a single prompt. Contributions of
all kinds are welcome — bug reports, documentation fixes, new providers, new
combine strategies, and more.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
Be kind, assume good intent, and keep discussion focused on the work.

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Reporting bugs](#reporting-bugs)
- [Requesting features](#requesting-features)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [The development loop](#the-development-loop)
- [Testing](#testing)
- [Coding conventions](#coding-conventions)
- [Documentation & changelog](#documentation--changelog)
- [Extending the library](#extending-the-library)
- [Submitting a pull request](#submitting-a-pull-request)
- [License](#license)

## Ways to contribute

- **Report a bug** or **request a feature** via [GitHub issues](https://github.com/kodar-anders/combined-ai/issues).
- **Improve the docs** — the `README.md`, inline doc-comments, or this guide.
- **Fix a bug** or **add functionality** — see [Extending the library](#extending-the-library).

If you're planning a substantial change (a new provider, a new strategy, an API
change), please **open an issue first** to discuss the approach before investing
time in a PR. Small fixes can go straight to a pull request.

## Reporting bugs

Open an issue and include:

- What you did, what you expected, and what actually happened.
- A **minimal reproduction** — the smallest snippet that triggers it.
- Versions: the `combined-ai` version, Node version (`node --version`), and OS.
- Any `ProviderError` details (`kind`, `status`, `code`) if a provider call failed.

Please **don't paste API keys, tokens, or other secrets** into issues or PRs.

> **Found a security vulnerability?** Don't open a public issue — report it
> privately. See [SECURITY.md](./SECURITY.md).

## Requesting features

Describe the problem you're trying to solve, not just the solution you have in
mind — that helps us find the best fit for the library's contract. For new
providers or strategies, see the design notes in
[Extending the library](#extending-the-library).

## Development setup

**Requirements:** Node.js ≥ 20 and [Yarn 4](https://yarnpkg.com/) (via Corepack).

This repo uses **Yarn 4 with Plug'n'Play** — there is no `node_modules`. Always
use `yarn`, never `npm`.

```bash
# Fork and clone, then:
corepack enable          # makes the pinned Yarn 4 available
yarn install --immutable # install dependencies (matches CI)
```

A PnP gotcha to know: code can only import dependencies that are declared
directly in `package.json`. If you add an import from a transitive dependency,
add it as an explicit dependency too.

## Project layout

```
src/
  index.ts          # the ONLY public entry point — re-exports the public API
  types.ts          # the provider-agnostic contract (Message, Provider, …)
  registry.ts       # ProviderRegistry — the single point of access
  errors.ts         # ProviderError vocabulary
  transport.ts      # fetch + bounded retry/backoff
  providers/        # one file per provider (anthropic, openai, google) + shared helpers
  combine/          # one file per strategy (consensus, pipeline, ensemble, broadcast)
  **/__tests__/     # colocated unit tests (mocked) + *.integration.test.ts (live)
```

Provider classes and strategy orchestrators are **internal** — only the registry
and the types declared in `src/index.ts` are public. Don't export concrete
provider classes.

## The development loop

Run these as you work (not just at the end). They mirror what CI enforces:

```bash
yarn lint        # ESLint (type-aware) — or `yarn eslint <path>` for one file
yarn typecheck   # tsc --noEmit
yarn test        # Jest — mocked, never makes network calls
yarn format      # Prettier --write (`yarn format:check` to verify only)
yarn build       # tsup bundle to dist/ (ESM + CJS + types)
```

When iterating on a single file it's faster to scope the checks:

```bash
yarn eslint src/providers/openai.ts
yarn test src/providers/__tests__/openai.test.ts
```

CI (`.github/workflows/ci.yml`) runs `yarn lint`, `yarn typecheck`, `yarn test`,
and `yarn build` on every pull request. A PR must pass all four to merge.

## Testing

- **Unit tests are mocked and network-free.** Provider tests mock `fetch`;
  combine tests use in-memory fake `Provider`s. New behavior needs a unit test.
- **Tests are colocated** in `__tests__/` folders next to the code, imported via
  relative paths (`../<file>`). Test files import globals from `@jest/globals`.
- Tests run through **`@swc/jest`**, which does **not** type-check — that's what
  `yarn typecheck` is for. Run both.

### Live integration tests

`*.integration.test.ts` files make **real, paid API calls** and are skipped by
default. Don't run them unless you're specifically testing live behavior. They
are double-gated — a suite runs only when both `RUN_LIVE_TESTS=1` (set by the
script) and the relevant provider key are present:

```bash
cp .env.example .env       # then add your key(s) — .env is gitignored
yarn test:integration                      # all integration suites
yarn test:integration openai.integration   # one provider's suite
```

The combine suites are triple-gated on all three provider keys. Live tests use
cheap models and small token caps to keep cost negligible. **Never commit a
`.env` file or any key.**

## Coding conventions

Most of this is enforced by ESLint + Prettier; the highlights:

- **TypeScript style:** `type` over `interface`; inline `import type`; exported
  API needs explicit types and explicit return types.
- **Formatting is owned by Prettier** — don't hand-format; run `yarn format`.
- **No `console`** in library code (`no-console` is an error; it's allowed in
  tests). Prefix intentionally unused args with `_`.
- **No SDK dependencies.** Providers talk to their HTTP API directly over the
  global `fetch`. Keep the dependency footprint minimal.
- **The library never reads environment variables** — keys are always passed in
  through the registry config. Only tests read env (via the gitignored `.env`).
- **Don't over-engineer.** No abstractions for hypothetical needs and no
  unrelated refactors bundled into a fix. Prefer a little inline duplication over
  a premature shared helper — a helper earns its place in `combine/shared.ts`
  only once a second strategy actually reuses it.

## Documentation & changelog

- Keep the **`README.md`** (and the relevant page under **`docs/`**) current when
  you change public behavior.
- Record notable changes in **`CHANGELOG.md`** under `## [Unreleased]`, following
  the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
  (`### Added` / `### Changed` / `### Fixed`). Dated version headings are added
  by maintainers at release time, not in feature PRs.

## Extending the library

The two most common extensions have a fixed recipe (see `CLAUDE.md` for the
detailed contract notes):

**Adding a provider:**

1. Create `src/providers/<name>.ts` implementing the `Provider` interface
   (`complete()` and `stream()`), mapping `Message.content` to the wire format and
   normalizing `finishReason` / `usage`.
2. Add an optional config field to `ProviderRegistryConfig` and a construction
   branch in `src/registry.ts`.
3. Re-export only the provider's **options type** from `src/index.ts` (not the
   class).
4. Add mocked unit tests, and ideally an opt-in `*.integration.test.ts`.

**Adding a combine strategy:**

1. Create `src/combine/<strategy>.ts` exporting its orchestrator.
2. Register it in `src/combine/index.ts`: add to `STRATEGY_NAMES` / `StrategyName`,
   add a `<Strategy>Request` and a `…Result` member, and a `StrategyRequest` entry.
3. Add a public method and a `combine()` `case` in `src/registry.ts`.
4. Add unit tests using fake providers.

For anything that adds or changes a public type, double-check it's surfaced
through `src/index.ts` and documented in the README's Public API section.

## Submitting a pull request

1. **Fork** the repo and create a topic branch from `main`.
2. Make your change with tests, and run the full [development loop](#the-development-loop)
   locally — `lint`, `typecheck`, `test`, and `build` should all pass.
3. Update the **README** and **CHANGELOG** if behavior changed.
4. Write a clear PR description: what changed, why, and how to verify it. Link any
   related issue.
5. Keep PRs focused — one logical change per PR makes review faster.
6. Be responsive to review feedback; maintainers may ask for changes before merge.

There's no CLA. By contributing, you agree that your contributions are licensed
under the project's [MIT License](#license).

## License

By contributing to combined-ai, you agree that your contributions will be
licensed under the [MIT License](./LICENSE).
