# Cost, pricing & caching

Pricing helpers for single-provider and combine runs, plus Anthropic prompt
caching. All of these are exported from the package entry point.

- [Cost & pricing](#cost--pricing)
- [Combine cost & budgets](#combine-cost--budgets)
- [Prompt caching](#prompt-caching)

## Cost & pricing

`costOf(result)` turns the token `usage` a completion reports into a dollar
`CostBreakdown`, using a tiny built-in pricing registry:

```ts
import { costOf } from "combined-ai";

const result = await registry.select("anthropic").complete({ messages });
const cost = costOf(result);
// → { model: "claude-opus-4-8", inputCost, outputCost, totalCost } | undefined
if (cost) console.log(`$${cost.totalCost.toFixed(4)}`);
```

It returns `undefined` (never throws) when the model isn't in the registry or the
result carries no `usage` — both normal for custom/gateway providers.
`costOfUsage(usage, model)` is the same calculation from a raw `Usage` + model id.

The registry resolves dated snapshots and Gemini `modelVersion` strings to their
base entry (e.g. `gpt-4.1-2025-04-14` → `gpt-4.1`). Costs are raw floating-point
USD — round at display.

**Prices are best-effort and hand-maintained** (a small table of the most common
models across the three providers, not an exhaustive catalog), dated by
`PRICING_VERIFIED_ON`. Correct a stale price or add your own model with
`options.models` — no library release needed:

```ts
costOf(result, {
  models: { "my-model": { inputPerMTok: 0.5, outputPerMTok: 1.5 } },
});
```

`findModel(id)` and `listModels()` expose the registry directly.

## Combine cost & budgets

A combine makes several model calls, so `costOf` (single-result) isn't enough.
`combineCost(result, options?)` prices a finished run in USD, summing each call
individually from the result's per-call `usage.calls` ledger:

```ts
import { combineCost } from "combined-ai";

const result = await registry.combine({ messages, participants });
const cost = combineCost(result); // { totalCost, byParticipant } in USD, or undefined
```

It returns `undefined` when nothing is priceable (no usage, or every call's model
is unknown to the registry). Calls whose model the registry doesn't know are
skipped, so `totalCost` can understate a mixed run — pass `options.models` (the
same override as `costOf`) to price custom-provider models.

Pass a **budget** to cap spend. It's a best-effort _soft floor on optional work_,
not a hard cap: the phases required to produce an answer (consensus drafts +
synthesis, the pipeline's first stage) always run, so realized cost can exceed
it — but once the running cost crosses the ceiling, the run skips its _optional_
phases (consensus critiques/sanitize, pipeline refiners/sanitize) and emits a
`budget` event.

```ts
await registry.combine(
  { messages, participants: ["anthropic", "openai", "google"] },
  { budget: { usd: 0.05, models: myPricingOverrides } },
);
```

Cost is priced with the built-in registry; pass `budget.models` to price custom
models (a call that can't be priced contributes 0, so a budget over an
all-uncatalogued roster never triggers). Budget on the `ensemble`/`broadcast`
strategies is accepted for a uniform API but **inert** — their single parallel
fan-out has no later phase to pre-empt, so they emit no `budget` event; price a
finished run with `combineCost(result)` instead.

## Prompt caching

Prompt caching is reflected in dollars. `usage.inputTokens` is the total billable
prompt; `cachedInputTokens` (a discounted cache read) and
`cacheCreationInputTokens` (an Anthropic cache write, billed at a premium) are
subsets of it, set only when the provider reports them:

| Provider  | Cache-read field                | Notes                              |
| --------- | ------------------------------- | ---------------------------------- |
| Anthropic | `cache_read` / `cache_creation` | Read + write, built-in rates.      |
| OpenAI    | `cached_tokens`                 | Falls back to the full input rate. |
| Gemini    | `cachedContentTokenCount` (2.5) | Read, built-in rate.               |

`costOf` bills reads at `cachedInputPerMTok` and writes at
`cacheWriteInputPerMTok`, each falling back to the normal input rate when a model
lists no cache rate (Anthropic and Gemini rates are built in; OpenAI falls back
until added — supply it via `options.models`). Reporting is `complete()`-only
(streaming reports no usage).

To **enable** caching: OpenAI and Gemini 2.5 cache automatically, so reporting
just works. Anthropic is manual — mark a cache breakpoint with `cacheControl` on a
content part or on the system prompt's object form (Anthropic caches the prefix up
to the marker and re-uses it at ~90% off on later requests with the same prefix):

```ts
await registry.select("anthropic").complete({
  system: { text: bigStableInstructions, cacheControl: {} }, // 5-min cache
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: bigSharedContext, cacheControl: { ttl: "1h" } },
        { type: "text", text: "What changed since yesterday?" }, // varies — after the breakpoint
      ],
    },
  ],
});
```

Omit `ttl` for the default 5-minute cache; `"1h"` opts into the 1-hour cache (the
1-hour beta header is sent automatically). At most 4 breakpoints per request.
OpenAI and Gemini ignore the marker; `combine` ignores it (its strategies build
their own prompts). The relevant types are `CacheControl` and `SystemPrompt`.
