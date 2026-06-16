/**
 * Live contract test for the consensus combine across all three providers.
 *
 * Triple-gated so it never fires by accident: it runs only when
 * `RUN_LIVE_TESTS=1` AND all three provider keys (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GEMINI_API_KEY`) are set — consensus needs at least two
 * participants, and this exercises the full three-way flow. Otherwise the suite
 * is skipped. Run it with `yarn test:integration consensus.integration`.
 *
 * Each provider is configured with its cheap model (the combine request applies
 * one `model` to every participant, so per-provider models come from the
 * registry config defaults instead). `maxTokens` is generous because Gemini 2.5
 * spends thinking tokens against the cap (see the README note) and the critique/
 * synthesis phases produce longer output than a one-word reply.
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

// Three providers × three phases means several sequential round trips.
const TIMEOUT_MS = 120_000;

describeLive("ProviderRegistry.combine consensus (live)", () => {
  const registry = new ProviderRegistry({
    anthropic: { apiKey: anthropicKey ?? "", model: "claude-haiku-4-5" },
    openai: { apiKey: openaiKey ?? "", model: "gpt-4.1-mini" },
    google: { apiKey: geminiKey ?? "", model: "gemini-2.5-flash" },
  });

  it(
    "drafts, critiques, and synthesizes a real answer",
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
          // Generous: critiques now carry reasoning + a verdict, and Gemini 2.5
          // spends thinking tokens against this cap (see the README note).
          maxTokens: 2048,
        },
        {
          onEvent: (event) => {
            events.push(event);
            // Print progress as the live run unfolds.
            console.log(
              event.type === "phase"
                ? `→ ${event.phase}`
                : `  ${event.type} ${event.provider}: ${event.status}`,
            );
          },
        },
      );

      // `combine()` returns a strategy-discriminated union; narrow to consensus.
      if (result.strategy !== "consensus") {
        throw new Error(
          `expected a consensus result, got "${result.strategy}"`,
        );
      }

      // Surface the actual error behind any failed draft/critique (e.g. Gemini).
      for (const outcome of [...result.drafts, ...result.critiques]) {
        if (outcome.status === "failed") {
          console.log(`FAILED ${outcome.provider}: ${outcome.error.message}`);
        }
      }

      console.log("Synthesizer:", result.synthesizer);
      console.log("Final answer:", result.text);

      expect(result.strategy).toBe("consensus");
      expect(result.text.length).toBeGreaterThan(0);
      // Default synthesizer is the first participant (unless it failed).
      expect(["anthropic", "openai", "google"]).toContain(result.synthesizer);
      // Every participant drafted and critiqued.
      expect(result.drafts.length).toBeGreaterThanOrEqual(2);
      expect(result.critiques.length).toBeGreaterThanOrEqual(2);
      expect(result.drafts.every((d) => d.status === "ok")).toBe(true);

      // Progress events fired for all three phases.
      const phases = events.flatMap((e) =>
        e.type === "phase" ? [e.phase] : [],
      );
      expect(phases).toEqual(["drafting", "critiquing", "synthesizing"]);
    },
    TIMEOUT_MS,
  );
});
