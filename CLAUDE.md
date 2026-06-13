# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **plain TypeScript library** meant to be imported by other projects. `src/index.ts` is the public entry point — re-export the package's public API from there. Still early-stage (minimal real code), but the foundations (build, test, lint, type-check) are in place.

## Commands

- `yarn build` — bundle `src/index.ts` to `dist/` via **tsup** as dual ESM (`index.js`) + CJS (`index.cjs`) with `.d.ts`/`.d.cts` declarations and sourcemaps.
- `yarn typecheck` — `tsc --noEmit`. tsc is type-check only; tsup owns the build.
- `yarn test` — Jest. Single test: `yarn test <pattern>` or `yarn test -t "<name>"`. Watch: `yarn test:watch`.
- `yarn lint` / `yarn lint:fix` — ESLint.
- `yarn format` / `yarn format:check` — Prettier.

## Architecture / toolchain choices

- **Build = tsup, type-check = tsc.** tsconfig has `noEmit: true`; it exists for editor IntelliSense and `yarn typecheck` only. The build settings live in the `tsup` flags in `package.json`'s `build` script.
- **Tests run through `@swc/jest`** (`jest.config.mjs`), which transpiles TS→CJS fast and does *no* type-checking — types are covered separately by `yarn typecheck`. Test files import globals explicitly from `@jest/globals` (e.g. `import { describe, it, expect } from "@jest/globals"`) rather than relying on ambient types.
- **Dual-format packaging** is wired in `package.json` via the `exports` map (`import`→`.js`/`.d.ts`, `require`→`.cjs`/`.d.cts`). `files: ["dist"]` and `prepack: yarn build` mean the build is produced on publish/pack.

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
- Not git-tracked (no `.git`).
