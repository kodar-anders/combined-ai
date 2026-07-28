import { describe, expect, it } from "@jest/globals";

import { type ProviderName } from "../../registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
} from "../../types";
import { ensemble } from "../ensemble";
import { type ResolvedEmbedder } from "../embedding";
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

    await ensemble(roster, request({ participants: ["anthropic", "openai"] }), {
      onEvent: (event) => events.push(event),
    });

    // The settlement event carries the whole result, so an incremental UI reaches
    // `parsed` — the structured object, not just its serialized text.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "response",
        id: "anthropic",
        provider: "anthropic",
        status: "ok",
        result: expect.objectContaining({ parsed: { city: "Paris", pop: 5 } }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "response",
        id: "openai",
        provider: "openai",
        status: "failed",
        error: expect.any(Error),
      }),
    );
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

  it("accepts budget as informational without pre-empting the fan-out", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris" } }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, { parsed: { city: "Paris" } }),
      ),
    ];

    const result = await ensemble(
      roster,
      request({ participants: ["anthropic", "openai"] }),
      { budget: { usd: 0.000_001 } },
    );

    // A budget can't gate a single parallel burst, so both still answered and the
    // vote merged as usual.
    expect(result.responses).toHaveLength(2);
    expect(result.merged.city).toBe("Paris");
  });

  it("adds per-field semanticAgreement for string fields without changing the merge", async () => {
    // Three paraphrases of the same city → identical vectors (semantic ~1),
    // though they are three distinct strings (exact-match agreement 1/3).
    const cityVectors: Record<string, number[]> = {
      Paris: [1, 0],
      "Paris, France": [1, 0],
      "The city of Paris": [1, 0],
    };
    const embedder: ResolvedEmbedder = {
      name: "emb",
      provider: {
        name: "emb",
        complete: () => {
          throw new Error("complete not used in this test");
        },
        stream: () => {
          throw new Error("stream not used in this test");
        },
        embed: (req: EmbeddingRequest): Promise<EmbeddingResult> =>
          Promise.resolve({
            embeddings: req.input.map((t) => cityVectors[t] ?? [0, 0]),
            model: "embed-model",
          }),
      },
    };
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, {
          parsed: { city: "Paris, France", pop: 5 },
        }),
      ),
      entry(
        "gemini",
        fakeProvider("gemini", calls, {
          parsed: { city: "The city of Paris", pop: 5 },
        }),
      ),
    ];

    const result = await ensemble(roster, request(), undefined, embedder);

    // The merge is still the deterministic exact-match vote (first-seen value).
    expect(result.merged.city).toBe("Paris");
    // Semantic agreement sees the paraphrases as the same (~1); the numeric `pop`
    // field is excluded (string fields only).
    expect(result.semanticAgreement?.city).toBeCloseTo(1);
    expect(result.semanticAgreement?.pop).toBeUndefined();
  });

  it("omits semanticAgreement when no embedder is configured", async () => {
    const calls: Call[] = [];
    const roster = [
      entry(
        "anthropic",
        fakeProvider("anthropic", calls, { parsed: { city: "Paris", pop: 5 } }),
      ),
      entry(
        "openai",
        fakeProvider("openai", calls, { parsed: { city: "Lyon", pop: 5 } }),
      ),
    ];

    const result = await ensemble(
      roster,
      request({ participants: ["anthropic", "openai"] }),
    );

    expect(result.semanticAgreement).toBeUndefined();
  });

  describe("votes (per-field dissent detail)", () => {
    it("groups each field's values with the ids that returned them, flagging the winner", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { total: "12450.00" } }),
        ),
        entry(
          "openai",
          fakeProvider("openai", calls, { parsed: { total: "1245.00" } }),
        ),
        entry(
          "gemini",
          fakeProvider("gemini", calls, { parsed: { total: "12450.00" } }),
        ),
      ];

      const result = await ensemble(roster, request());

      // The reviewer's question — "who said what?" — answered without re-walking
      // `responses` or reimplementing the vote's equality rule.
      expect(result.votes.total).toEqual({
        candidates: [
          { value: "12450.00", ids: ["anthropic", "gemini"], winner: true },
          { value: "1245.00", ids: ["openai"], winner: false },
        ],
        absent: [],
      });
      expect(result.merged.total).toBe("12450.00");
    });

    it("reports a unanimous field as a single candidate with nobody absent", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { city: "Paris" } }),
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

      expect(result.votes.city?.candidates).toHaveLength(1);
      expect(result.votes.city?.candidates[0]).toEqual({
        value: "Paris",
        ids: ["anthropic", "openai", "gemini"],
        winner: true,
      });
      expect(result.votes.city?.absent).toEqual([]);
    });

    it("names the participants that omitted a field in `absent`", async () => {
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

      // `note` scores 1/3 because two participants omitted it, not because they
      // disagreed — `absent` is what tells those two causes apart.
      expect(result.agreement.byField.note).toBeCloseTo(1 / 3);
      expect(result.votes.note?.candidates).toHaveLength(1);
      expect(result.votes.note?.absent).toEqual(["openai", "gemini"]);
    });

    it("resolves a tie to the first-seen value, not the first to reach the winning count", async () => {
      // The discriminating case: with 4 participants voting A,B,B,A both values end
      // on 2, but B *reaches* 2 first. The documented rule is first-seen, so A wins.
      // A 2- or 3-participant tie passes under either rule and would pin nothing.
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { pick: "A" } }),
        ),
        entry(
          "openai",
          fakeProvider("openai", calls, { parsed: { pick: "B" } }),
        ),
        entry(
          "gemini",
          fakeProvider("gemini", calls, { parsed: { pick: "B" } }),
        ),
        entry(
          "custom",
          fakeProvider("custom", calls, { parsed: { pick: "A" } }),
        ),
      ];

      const result = await ensemble(
        roster,
        request({
          participants: ["anthropic", "openai", "gemini", "custom"],
        }),
      );

      expect(result.merged.pick).toBe("A");
      expect(result.votes.pick?.candidates).toEqual([
        { value: "A", ids: ["anthropic", "custom"], winner: true },
        { value: "B", ids: ["openai", "gemini"], winner: false },
      ]);
      expect(result.agreement.byField.pick).toBeCloseTo(0.5);
    });

    it("treats a returned null as a candidate, not an omission", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { due: null } }),
        ),
        entry(
          "openai",
          fakeProvider("openai", calls, { parsed: { due: "2026-01-01" } }),
        ),
      ];

      const result = await ensemble(
        roster,
        request({ participants: ["anthropic", "openai"] }),
      );

      // null is a value a model actually returned — it votes, and it wins the tie
      // by being first-seen. Absence is a separate concept.
      expect(result.merged.due).toBeNull();
      expect(result.votes.due?.candidates).toEqual([
        { value: null, ids: ["anthropic"], winner: true },
        { value: "2026-01-01", ids: ["openai"], winner: false },
      ]);
      expect(result.votes.due?.absent).toEqual([]);
    });

    it("groups objects that differ only in key order into one candidate", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { at: { a: 1, b: 2 } } }),
        ),
        entry(
          "openai",
          fakeProvider("openai", calls, { parsed: { at: { b: 2, a: 1 } } }),
        ),
      ];

      const result = await ensemble(
        roster,
        request({ participants: ["anthropic", "openai"] }),
      );

      // Deep equality, so key order isn't disagreement.
      expect(result.votes.at?.candidates).toHaveLength(1);
      expect(result.votes.at?.candidates[0]?.ids).toEqual([
        "anthropic",
        "openai",
      ]);
      expect(result.agreement.byField.at).toBeCloseTo(1);
    });

    it("counts only valid responses, in neither candidates nor absent otherwise", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { city: "Paris" } }),
        ),
        entry("openai", fakeProvider("openai", calls, { fail: true })),
        entry("gemini", fakeProvider("gemini", calls, { parsed: undefined })),
        // A plain-object root is required: an array `parsed` is dropped wholesale.
        entry(
          "custom",
          fakeProvider("custom", calls, { parsed: [{ city: "x" }] }),
        ),
      ];

      const result = await ensemble(
        roster,
        request({
          participants: ["anthropic", "openai", "gemini", "custom"],
        }),
      );

      expect(result.agreement.validResponseCount).toBe(1);
      expect(result.votes.city?.candidates).toEqual([
        { value: "Paris", ids: ["anthropic"], winner: true },
      ]);
      // The three excluded participants didn't "omit the field" — they never voted.
      expect(result.votes.city?.absent).toEqual([]);
      expect(result.responses).toHaveLength(4);
    });

    it("accounts for every valid response in each field's vote", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { a: 1, b: 2 } }),
        ),
        entry("openai", fakeProvider("openai", calls, { parsed: { a: 1 } })),
        entry("gemini", fakeProvider("gemini", calls, { parsed: { c: 3 } })),
      ];

      const result = await ensemble(roster, request());

      // The invariant that makes `absent` trustworthy: candidates + absent covers
      // exactly the responses the vote counted, for every field.
      expect(result.agreement.validResponseCount).toBe(3);
      for (const vote of Object.values(result.votes)) {
        const voters = vote.candidates.reduce((n, c) => n + c.ids.length, 0);
        expect(voters + vote.absent.length).toBe(
          result.agreement.validResponseCount,
        );
      }
      expect(Object.keys(result.votes)).toEqual(Object.keys(result.merged));
    });

    it("keeps a __proto__ field as real data instead of polluting the merge", async () => {
      const calls: Call[] = [];
      // A model can emit any JSON, and JSON.parse makes `__proto__` an ordinary own
      // enumerable key. Assigning it by index would invoke the prototype setter:
      // the field would vanish from `merged`/`text` and the record's prototype would
      // be replaced. Object.fromEntries defines a real own property instead.
      const payload = JSON.parse(
        '{"city":"Paris","__proto__":{"pwned":true}}',
      ) as Record<string, unknown>;
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: payload }),
        ),
        entry("openai", fakeProvider("openai", calls, { parsed: payload })),
      ];

      const result = await ensemble(
        roster,
        request({ participants: ["anthropic", "openai"] }),
      );

      expect(Object.keys(result.merged)).toEqual(["city", "__proto__"]);
      expect(Object.keys(result.votes)).toEqual(["city", "__proto__"]);
      expect(Object.keys(result.agreement.byField)).toEqual([
        "city",
        "__proto__",
      ]);
      // No prototype pollution: the payload's object didn't become the prototype.
      expect(Object.getPrototypeOf(result.merged)).toBe(Object.prototype);
      expect((result.merged as { pwned?: unknown }).pwned).toBeUndefined();
      // And the field survives serialization instead of vanishing from `text`.
      // (Built with fromEntries, not a literal — `__proto__:` in an object literal
      // assigns the prototype rather than an own key, which is the same trap.)
      const round = JSON.parse(result.text) as Record<string, unknown>;
      expect(round).toEqual(
        Object.fromEntries([
          ["city", "Paris"],
          ["__proto__", { pwned: true }],
        ]),
      );
    });

    it("reports the vote denominator as the number of valid responses", async () => {
      const calls: Call[] = [];
      const roster = [
        entry(
          "anthropic",
          fakeProvider("anthropic", calls, { parsed: { city: "Paris" } }),
        ),
        entry(
          "openai",
          fakeProvider("openai", calls, { parsed: { city: "Lyon" } }),
        ),
        entry("gemini", fakeProvider("gemini", calls, { fail: true })),
      ];

      const result = await ensemble(roster, request());

      // 3 participants, 2 valid → the denominator every byField score divides by.
      expect(result.agreement.validResponseCount).toBe(2);
      expect(result.agreement.byField.city).toBeCloseTo(0.5);
      const winner = result.votes.city?.candidates.find((c) => c.winner);
      expect(winner?.ids).toEqual(["anthropic"]);
    });
  });
});
