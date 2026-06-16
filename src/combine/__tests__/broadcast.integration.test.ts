/**
 * Live contract test for the broadcast combine across all three providers.
 *
 * Triple-gated so it never fires by accident: it runs only when
 * `RUN_LIVE_TESTS=1` AND all three provider keys (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GEMINI_API_KEY`) are set — this exercises the full
 * three-way fan-out. Otherwise the suite is skipped. Run it with
 * `yarn test:integration broadcast.integration`.
 *
 * Each provider is configured with its cheap model (the combine request applies
 * one `model` to every participant, so per-provider models come from the registry
 * config defaults instead). `maxTokens` is generous because Gemini 2.5 spends
 * thinking tokens against the cap (see the README note).
 */

import { describe, expect, it } from "@jest/globals";

import { ProviderRegistry } from "../../registry";
import { type CombineEvent } from "../index";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const live =
  process.env.RUN_LIVE_TESTS === "1" &&
  anthropicKey !== undefined &&
  openaiKey !== undefined &&
  geminiKey !== undefined;
const describeLive = live ? describe : describe.skip;

// One parallel round trip per provider.
const TIMEOUT_MS = 120_000;

describeLive("ProviderRegistry.combine broadcast (live)", () => {
  const registry = new ProviderRegistry({
    anthropic: { apiKey: anthropicKey ?? "", model: "claude-haiku-4-5" },
    openai: { apiKey: openaiKey ?? "", model: "gpt-4.1-mini" },
    google: { apiKey: geminiKey ?? "", model: "gemini-2.5-flash" },
  });

  it(
    "returns a raw answer from every participant",
    async () => {
      const events: CombineEvent[] = [];
      const result = await registry.combine(
        {
          messages: [
            {
              role: "user",
              content: "In one sentence, what makes a good API?",
            },
          ],
          participants: ["anthropic", "openai", "google"],
          strategy: "broadcast",
          // Gemini 2.5 spends thinking tokens against this cap (see the README note).
          maxTokens: 2048,
        },
        {
          onEvent: (event) => {
            events.push(event);
            if (event.type === "response") {
              console.log(`  ${event.provider}: ${event.status}`);
            }
          },
        },
      );

      // `combine({ strategy: "broadcast" })` returns a typed `BroadcastResult`
      // (no union narrowing needed) — `result.responses` is in scope.
      for (const response of result.responses) {
        if (response.status === "failed") {
          console.log(`FAILED ${response.provider}: ${response.error.message}`);
        } else {
          console.log(`${response.provider}:`, response.result.text);
        }
      }

      // One response per participant, in participant order, all successful.
      expect(result.responses.map((o) => o.provider)).toEqual([
        "anthropic",
        "openai",
        "google",
      ]);
      expect(result.responses.every((o) => o.status === "ok")).toBe(true);
      const texts = result.responses.flatMap((o) =>
        o.status === "ok" ? [o.result.text] : [],
      );
      for (const text of texts) {
        expect(text.length).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );
});
