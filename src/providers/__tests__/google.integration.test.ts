/**
 * Live contract test against the real Google Gemini API.
 *
 * Double-gated so it never fires by accident: it runs only when BOTH
 * `RUN_LIVE_TESTS=1` and `GEMINI_API_KEY` are set — otherwise the suite is
 * skipped. Run it with `yarn test:integration`. Uses a cheap model and a tiny
 * token cap to keep cost negligible.
 */

import { describe, expect, it } from "@jest/globals";

import { GoogleProvider } from "../google";

const apiKey = process.env.GEMINI_API_KEY;
const live = process.env.RUN_LIVE_TESTS === "1" && apiKey !== undefined;
const describeLive = live ? describe : describe.skip;

const TIMEOUT_MS = 30_000;

describeLive("GoogleProvider (live)", () => {
  const provider = new GoogleProvider({
    apiKey: apiKey ?? "",
    model: "gemini-2.5-flash",
  });

  it(
    "completes a real request",
    async () => {
      const result = await provider.complete({
        messages: [
          { role: "user", content: "Reply with the single word: pong" },
        ],
        // Gemini 2.5 is a thinking model: thinking tokens count against
        // maxTokens, so a tiny cap leaves no room for the visible answer.
        maxTokens: 512,
      });

      expect(result.text.length).toBeGreaterThan(0);
      expect(result.model).toContain("gemini-2.5-flash");
      console.log("Completion result:", result.text);
    },
    TIMEOUT_MS,
  );

  it(
    "streams a real request",
    async () => {
      const deltas: string[] = [];
      for await (const delta of provider.stream({
        // A longer answer makes Gemini split the response across multiple SSE
        // chunks, so we can assert real incremental streaming (≥ 2 deltas)
        // rather than a single all-at-once payload.
        messages: [
          { role: "user", content: "Write a four-line poem about the sea." },
        ],
        // Leave room for thinking tokens (see the complete test above).
        maxTokens: 512,
      })) {
        deltas.push(delta);
      }

      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas.join("").length).toBeGreaterThan(0);
      console.log("Stream result:", deltas.join(" | "));
    },
    TIMEOUT_MS,
  );

  it(
    "requests a tool call",
    async () => {
      const result = await provider.complete({
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ],
        toolChoice: { name: "get_weather" },
        // Leave room for thinking tokens (see the complete test above).
        maxTokens: 512,
      });

      expect(result.finishReason).toBe("tool_use");
      expect(result.toolCalls?.[0]?.name).toBe("get_weather");
      console.log("Tool call:", JSON.stringify(result.toolCalls));
    },
    TIMEOUT_MS,
  );
});
