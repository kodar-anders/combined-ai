/**
 * Live contract test against the real OpenAI API.
 *
 * Double-gated so it never fires by accident: it runs only when BOTH
 * `RUN_LIVE_TESTS=1` and `OPENAI_API_KEY` are set — otherwise the suite is
 * skipped. Run it with `yarn test:integration`. Uses a cheap model and a tiny
 * token cap to keep cost negligible.
 */

import { describe, expect, it } from "@jest/globals";

import { OpenAIProvider } from "../providers/openai";

const apiKey = process.env.OPENAI_API_KEY;
const live = process.env.RUN_LIVE_TESTS === "1" && apiKey !== undefined;
const describeLive = live ? describe : describe.skip;

const TIMEOUT_MS = 30_000;

describeLive("OpenAIProvider (live)", () => {
  const provider = new OpenAIProvider({
    apiKey: apiKey ?? "",
    model: "gpt-4.1-mini",
  });

  it(
    "completes a real request",
    async () => {
      const result = await provider.complete({
        messages: [
          { role: "user", content: "Reply with the single word: pong" },
        ],
        maxTokens: 16,
      });

      expect(result.text.length).toBeGreaterThan(0);
      expect(result.model).toContain("gpt-4.1");
      console.log("Completion result:", result.text);
    },
    TIMEOUT_MS,
  );

  it(
    "streams a real request",
    async () => {
      const deltas: string[] = [];
      for await (const delta of provider.stream({
        messages: [{ role: "user", content: "Count to three." }],
        maxTokens: 16,
      })) {
        deltas.push(delta);
      }

      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("").length).toBeGreaterThan(0);
      console.log("Stream result:", deltas.join(""));
    },
    TIMEOUT_MS,
  );
});
