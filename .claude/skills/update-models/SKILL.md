---
name: update-models
description: >-
  Refresh this library's model registry against the providers' official docs.
  Checks each provider (Anthropic, OpenAI, Google/Gemini) online for models the
  project is missing and adds them, double-checks every price in the pricing
  table, re-checks and recommends the default model per provider, and removes
  models that are retired / no longer usable. Use when asked to "update the
  models", "check for new models", "refresh pricing", "verify the model table",
  or "check the default models".
---

# Update models

Bring `src/models.ts` and the per-provider defaults back in sync with what the
providers actually offer today. This is an **interactive** procedure: research
online, then propose a concrete diff and confirm the judgment calls (defaults,
removals) with the user before editing.

## Ground rules (read first)

- **A wrong price is worse than `undefined`.** Never guess a price. If you can't
  verify a number on the official page, leave that model out of the table (the
  cost helpers then return `undefined`, which is the intended safe outcome).
- **Keep the table small.** It is the _most commonly used_ models per provider
  (current + recent generations + the cheap tiers), not an exhaustive catalog.
  Don't add every niche/specialized model.
- **Confirm the judgment calls.** Changing a `DEFAULT_MODEL` and removing a
  pricing entry are product decisions — surface a recommendation and use
  `AskUserQuestion` before doing either. Adding missing models and correcting a
  clearly-wrong price can be done directly (still report them).

## Key files

- `src/models.ts` — the `MODELS` pricing table, `PRICING_VERIFIED_ON`, and the
  `findModel` resolver. Read the file header and the `findModel` doc-comment for
  the full pricing/resolution rules before editing.
- `src/providers/anthropic.ts` — `const DEFAULT_MODEL` (no embeddings).
- `src/providers/openai.ts` — `const DEFAULT_MODEL` + `DEFAULT_EMBED_MODEL`.
- `src/providers/google.ts` — `const DEFAULT_MODEL` + `DEFAULT_EMBED_MODEL`.
- `src/providers/__tests__/<provider>.test.ts` — the default-path tests assert
  the default model in the request URL/body and the result (`model:` field).
- `README.md`, `CLAUDE.md`, `CHANGELOG.md` — doc references to defaults.

## Official sources

Prefer `WebFetch` on the official pages (exact ids + prices); use `WebSearch`
to discover what's new and to find deprecation dates.

- Anthropic pricing: https://platform.claude.com/docs/en/pricing
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- Google (Gemini) pricing: https://ai.google.dev/gemini-api/docs/pricing
- Google (Gemini) deprecations: https://ai.google.dev/gemini-api/docs/deprecations
- Also search for each provider's model-deprecation / retirement schedule.

The current month is later than the training cutoff — **do not answer from
memory**, always fetch. Model families move fast (e.g. tier names can change:
OpenAI's 5.6 line is Sol/Terra/Luna, not mini/nano).

## Procedure

### 1. Snapshot the current state

Read the `MODELS` table and each provider's `DEFAULT_MODEL`/`DEFAULT_EMBED_MODEL`.
Note `PRICING_VERIFIED_ON`. List what the library currently knows per provider.

### 2. Research each provider

For Anthropic, OpenAI, and Google gather, from the official pages:

- Current model **ids exactly as used in the API** (not marketing names).
- Input / output / cached-input price per 1M tokens; any **tiered** pricing
  (e.g. Gemini 2.5 Pro > 200k prompt tokens); cache-**write** rate (Anthropic).
- Which models are **GA vs preview**, and which are **deprecated/retired** with
  their shutdown dates.

### 3. Reconcile → propose a plan

Produce a concise diff plan, per provider:

- **Add** — current, common models missing from the table (respect "keep it
  small").
- **Fix price** — any table entry whose price ≠ the official page.
- **Remove** — retired/shut-down models (see step 6 for the nuance).
- **Default** — your recommended `DEFAULT_MODEL` and why.

Present this to the user before making the judgment-call edits.

### 4. Apply pricing-table edits (`src/models.ts`)

Follow the table's conventions (they are load-bearing — see the file header):

- USD per 1M tokens. Keys are grouped by provider with a short comment.
- **Exact keys.** The resolver matches `k-<DIGIT>…` only, so word-suffix
  siblings each need their own exact key (`-mini`, `-nano`, `-pro`, `-sol`,
  `-terra`, `-luna`, `-flash-lite`, …). A dated snapshot (`…-2026-07-09`)
  resolves to its base via the digit rule — don't add snapshot keys.
- `cachedInputPerMTok` **only when the page publishes it**; omit otherwise (the
  cost helpers fall back to the full input rate — never fabricate a discount).
- `cacheWriteInputPerMTok` — Anthropic only (1.25× input = the 5-minute TTL).
- `highTier` for tiered models (`aboveInputTokens` + input/output/cached rates).
- Embedding models: input-only, `outputPerMTok: 0`, full exact key.
- **`PRICING_VERIFIED_ON`:** bump to today **only if you re-verified _all three_
  providers' prices** this run. If you checked only one provider, leave it (a
  table-wide stamp must not over-claim).

### 5. Defaults — recommend + confirm

For each provider, recommend a `DEFAULT_MODEL`. Good default = **GA (not
preview)**, current generation, sensible price/capability for the provider's
"workhorse" tier, and not scheduled to retire soon. A same-price newer-generation
successor to the existing default is the ideal move. Use `AskUserQuestion` to let
the user pick (offer your recommendation first, marked "Recommended").

When a default changes, update **all** of these together:

1. `src/providers/<provider>.ts` — `DEFAULT_MODEL`.
2. `src/providers/__tests__/<provider>.test.ts` — the default-path test's URL,
   request-body `model`, and result `model` assertions. Keep any explicit-model
   override test pointed at a **different** model so it still proves overrides work.
3. `README.md` config example (and any prose reference to the default).
4. `CLAUDE.md` — the provider's one-line entry.

### 6. Removals — retired / not recommended

The table exists for **cost calculation**, and usage logs reference models long
after they stop being callable — so keeping a still-relevant entry is often
correct even when a model can't be newly selected. Remove an entry only when it
is **fully retired/shut down** (or the user wants the table trimmed). Removing
loses cost calc for historical usage of that model — surface that tradeoff and
confirm with the user (`AskUserQuestion`, per-model or as a batch) before
deleting. **Never remove a model that is still a `DEFAULT_MODEL`** — repoint the
default first (step 5). If a model is deprecated-but-active (e.g. 404s for new
keys yet still billed for existing ones until a future shutdown date), prefer to
**keep it with a dated retirement comment** rather than remove it.

### 7. Changelog

Add entries under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format):
`### Added` for new models, `### Changed` for default/price changes, `### Removed`
for deletions. Keep it short. Do **not** add a dated version heading (that's a
release-time step).

### 8. Verify (edit loop)

Run as you go, then once at the end on the touched files:

```
yarn eslint <changed files>
yarn typecheck
yarn prettier --write <changed files>
yarn test google models cost openai anthropic   # the suites this touches
```

Optional resolver sanity check via the built bundle (confirms new keys resolve
and word-suffix siblings don't mis-resolve):

```
yarn build
node -e 'import("./dist/index.js").then(({findModel})=>{for(const m of ["<new-id>","<new-id>-2026-01-01"])console.log(m,"->",findModel(m)?.id)})'
```

### 9. Report

Summarize per provider: models added, prices corrected, models removed, and the
new default (with the reasoning). State whether `PRICING_VERIFIED_ON` was bumped
and why/why not. Remind the user nothing was committed (unless they asked).
