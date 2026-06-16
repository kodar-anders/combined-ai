/**
 * Live contract test for the ensemble combine across all three providers.
 *
 * Triple-gated so it never fires by accident: it runs only when
 * `RUN_LIVE_TESTS=1` AND all three provider keys (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GEMINI_API_KEY`) are set — this exercises a real three-model
 * vote on structured output. Otherwise the suite is skipped. Run it with
 * `yarn test:integration ensemble.integration`.
 *
 * Each provider is configured with its cheap model (the combine request applies
 * one `model` to every participant, so per-provider models come from the registry
 * config defaults instead). `maxTokens` is generous because Gemini 2.5 spends
 * thinking tokens against the cap (see the README note). The schema follows the
 * documented cross-provider rules: every object sets `additionalProperties: false`
 * and lists every property in `required` with a single non-null type.
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

// Three parallel structured-output calls.
const TIMEOUT_MS = 120_000;

describeLive("ProviderRegistry.combine ensemble (live)", () => {
  const registry = new ProviderRegistry({
    anthropic: { apiKey: anthropicKey ?? "", model: "claude-haiku-4-5" },
    openai: { apiKey: openaiKey ?? "", model: "gpt-4.1-mini" },
    google: { apiKey: geminiKey ?? "", model: "gemini-2.5-flash" },
  });

  it(
    "votes three models onto one typed object with an agreement score",
    async () => {
      const events: CombineEvent[] = [];
      const result = await registry.combine(
        {
          messages: [
            {
              role: "user",
              content:
                "Extract the city and country where the Eiffel Tower is.",
            },
          ],
          participants: ["anthropic", "openai", "google"],
          strategy: "ensemble",
          responseFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                city: { type: "string" },
                country: { type: "string" },
              },
              required: ["city", "country"],
              additionalProperties: false,
            },
          },
          // Generous: Gemini 2.5 spends thinking tokens against this cap.
          maxTokens: 2048,
        },
        {
          onEvent: (event) => {
            events.push(event);
            if (event.type === "response") {
              console.log(`  response ${event.provider}: ${event.status}`);
            }
          },
        },
      );

      // `combine()` returns a strategy-discriminated union; narrow to ensemble.
      if (result.strategy !== "ensemble") {
        throw new Error(
          `expected an ensemble result, got "${result.strategy}"`,
        );
      }

      // Surface the actual error behind any failed response (e.g. Gemini).
      for (const response of result.responses) {
        if (response.status === "failed") {
          console.log(`FAILED ${response.provider}: ${response.error.message}`);
        }
      }

      console.log("Merged:", result.merged);
      console.log("Agreement:", result.agreement);

      expect(result.responses.map((r) => r.provider)).toEqual([
        "anthropic",
        "openai",
        "google",
      ]);
      // The models should agree on this unambiguous fact.
      expect(result.merged).toMatchObject({ city: "Paris", country: "France" });
      expect(result.agreement.overall).toBeGreaterThan(0);
      expect(result.agreement.overall).toBeLessThanOrEqual(1);
      expect(result.text).toBe(JSON.stringify(result.merged));
    },
    TIMEOUT_MS,
  );
});
