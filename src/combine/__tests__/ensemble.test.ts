import { describe, expect, it } from "@jest/globals";

import { type ProviderName } from "../../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from "../../types";
import { ensemble } from "../ensemble";
import { type CombineEvent, type CombineRequest } from "../index";

type Call = { provider: string; request: CompletionRequest };

/**
 * A network-free {@link Provider} for ensemble tests: returns a fixed structured
 * `parsed` object (echoed into `text`), or throws when `fail` is set. Records each
 * call so tests can assert the schema was threaded through.
 */
function fakeProvider(
  name: string,
  calls: Call[],
  outcome: { parsed?: unknown; fail?: boolean },
): Provider {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      calls.push({ provider: name, request });
      if (outcome.fail === true) {
        throw new Error(`${name} failed`);
      }
      return {
        text: JSON.stringify(outcome.parsed),
        model: `${name}-model`,
        parsed: outcome.parsed,
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *stream(): AsyncGenerator<string, void, void> {
      throw new Error("stream is not used by ensemble");
    },
  };
}

const SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, pop: { type: "number" } },
  required: ["city", "pop"],
  additionalProperties: false,
};

function request(overrides?: Partial<CombineRequest>): CombineRequest {
  return {
    messages: [{ role: "user", content: "Where is the Eiffel Tower?" }],
    participants: ["anthropic", "openai", "gemini"],
    strategy: "ensemble",
    responseFormat: { type: "json_schema", schema: SCHEMA },
    ...overrides,
  };
}

function entry(
  name: ProviderName,
  provider: Provider,
): {
  id: string;
  providerName: ProviderName;
  provider: Provider;
} {
  return { id: name, providerName: name, provider };
}

describe("ensemble", () => {
  it("merges every field by majority vote, with agreement", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, { parsed: { city: "Paris", pop: 7 } }),
      ),
      entry(
        "gemini",
        fakeProvider("gemini", calls, { parsed: { city: "London", pop: 9 } }),
      ),
    ];

    const result = await ensemble(roster, request());

    expect(result.strategy).toBe("ensemble");
    // Vote → "Paris" (2/3); pop is all-distinct so the first-seen value wins the tie.
    expect(result.merged).toEqual({ city: "Paris", pop: 5 });
    expect(result.text).toBe(JSON.stringify({ city: "Paris", pop: 5 }));
    expect(result.agreement.byField.city).toBeCloseTo(2 / 3);
    expect(result.agreement.byField.pop).toBeCloseTo(1 / 3); // all distinct → modal fraction 1/3
    expect(result.agreement.overall).toBeCloseTo(0.5);
    expect(result.responses).toHaveLength(3);
    expect(result.responses.every((o) => o.status === "ok")).toBe(true);
  });

  it("threads the responseFormat into every participant call", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry(
        "gemini",
        fakeProvider("gemini", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
    ];

    await ensemble(roster, request());

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.request.responseFormat).toEqual({
        type: "json_schema",
        schema: SCHEMA,
      });
    }
  });

  it("votes a numeric field to the agreed value (no median/averaging)", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { n: 5 } }),
      ),
      entry("openai", fakeProvider("openai", calls, { parsed: { n: 5 } })),
      entry("gemini", fakeProvider("gemini", calls, { parsed: { n: 9 } })),
    ];

    const result = await ensemble(roster, request());

    // Majority vote, not a median: the merged value is one a model actually
    // returned (5, agreed by two), never a synthesized average like 6.33.
    expect(result.merged).toEqual({ n: 5 });
    expect(result.agreement.byField.n).toBeCloseTo(2 / 3);
  });

  it("scores a field most models omitted as low confidence (denominator is all responses)", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, {
          parsed: { city: "Paris", note: "x" },
        }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, { parsed: { city: "Paris" } }),
      ),
      entry(
        "gemini",
        fakeProvider("gemini", calls, { parsed: { city: "Paris" } }),
      ),
    ];

    const result = await ensemble(roster, request());

    expect(result.merged).toEqual({ city: "Paris", note: "x" });
    expect(result.agreement.byField.city).toBeCloseTo(1); // all 3 returned and agreed
    // `note` came from only 1 of 3 responses → 1/3, not an inflated 1.0.
    expect(result.agreement.byField.note).toBeCloseTo(1 / 3);
  });

  it("excludes failed and invalid (non-object) responses but merges the rest", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry("openai", fakeProvider("openai", calls, { fail: true })),
      // ok call but no valid structured object (parsed undefined) — dropped from the merge.
      entry("gemini", fakeProvider("gemini", calls, { parsed: undefined })),
    ];

    const result = await ensemble(roster, request());

    expect(result.merged).toEqual({ city: "Paris", pop: 5 });
    expect(result.agreement.byField.city).toBeCloseTo(1); // only one object voted
    expect(result.responses).toHaveLength(3); // failures are still recorded
    expect(result.responses.map((o) => o.status)).toEqual([
      "ok",
      "failed",
      "ok",
    ]);
  });

  it("throws when no participant returns a valid structured object", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", fakeProvider("anthropic", calls, { fail: true })),
      entry("openai", fakeProvider("openai", calls, { parsed: undefined })),
    ];

    await expect(
      ensemble(roster, request({ participants: ["anthropic", "openai"] })),
    ).rejects.toThrow(/no participant returned a valid structured object/);
  });

  it("emits a response event as each participant settles", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry("openai", fakeProvider("openai", calls, { fail: true })),
    ];

    await ensemble(
      roster,
      request({ participants: ["anthropic", "openai"] }),
      (event) => events.push(event),
    );

    expect(events).toContainEqual({
      type: "response",
      id: "anthropic",
      provider: "anthropic",
      status: "ok",
    });
    expect(events).toContainEqual({
      type: "response",
      id: "openai",
      provider: "openai",
      status: "failed",
    });
  });

  it("applies each participant's model override to its call", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, {
          parsed: { city: "Paris" },
        }),
        model: "claude-x",
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, { parsed: { city: "Paris" } }),
        model: "gpt-x",
      },
    ];

    await ensemble(roster, request({ participants: ["anthropic", "openai"] }));

    expect(calls.find((c) => c.provider === "anthropic")?.request.model).toBe(
      "claude-x",
    );
    expect(calls.find((c) => c.provider === "openai")?.request.model).toBe(
      "gpt-x",
    );
  });
});
