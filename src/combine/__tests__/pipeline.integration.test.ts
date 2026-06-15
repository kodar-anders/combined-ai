/**
 * Live contract test for the pipeline combine across all three providers.
 *
 * Triple-gated so it never fires by accident: it runs only when
 * `RUN_LIVE_TESTS=1` AND all three provider keys (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GEMINI_API_KEY`) are set — this exercises the full
 * three-stage conveyor. Otherwise the suite is skipped. Run it with
 * `yarn test:integration pipeline.integration`.
 *
 * Each provider is configured with its cheap model (the combine request applies
 * one `model` to every participant, so per-provider models come from the
 * registry config defaults instead). `maxTokens` is generous because Gemini 2.5
 * spends thinking tokens against the cap (see the README note) and a refined
 * answer is longer than a one-word reply.
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

// Three sequential stages means several round trips.
const TIMEOUT_MS = 120_000;

describeLive("ProviderRegistry.combine pipeline (live)", () => {
  const registry = new ProviderRegistry({
    anthropic: { apiKey: anthropicKey ?? "", model: "claude-haiku-4-5" },
    openai: { apiKey: openaiKey ?? "", model: "gpt-4.1-mini" },
    gemini: { apiKey: geminiKey ?? "", model: "gemini-2.5-flash" },
  });

  it(
    "refines an answer through every stage in order",
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
          participants: ["anthropic", "openai", "gemini"],
          strategy: "pipeline",
          // Generous: refined answers are longer, and Gemini 2.5 spends thinking
          // tokens against this cap (see the README note).
          maxTokens: 2048,
        },
        {
          onEvent: (event) => {
            events.push(event);
            // Print progress as the live run unfolds.
            if (event.type === "stage") {
              console.log(
                `  stage ${String(event.index)} ${event.provider}: ${event.status}`,
              );
            }
          },
        },
      );

      // `combine()` returns a strategy-discriminated union; narrow to pipeline.
      if (result.strategy !== "pipeline") {
        throw new Error(`expected a pipeline result, got "${result.strategy}"`);
      }

      // Surface the actual error behind any failed stage (e.g. Gemini).
      for (const stage of result.stages) {
        if (stage.status === "failed") {
          console.log(`FAILED ${stage.provider}: ${stage.error.message}`);
        }
      }

      console.log("Final provider:", result.finalProvider);
      console.log("Final answer:", result.text);

      expect(result.text.length).toBeGreaterThan(0);
      // One stage per participant, in conveyor order.
      expect(result.stages.map((s) => s.provider)).toEqual([
        "anthropic",
        "openai",
        "gemini",
      ]);
      expect(result.stages.every((s) => s.status === "ok")).toBe(true);
      // The last stage to produce an answer is the final provider.
      expect(["anthropic", "openai", "gemini"]).toContain(result.finalProvider);

      // A stage event fired for each participant, in order.
      const stages = events.flatMap((e) =>
        e.type === "stage" ? [e.provider] : [],
      );
      expect(stages).toEqual(["anthropic", "openai", "gemini"]);
    },
    TIMEOUT_MS,
  );
});
