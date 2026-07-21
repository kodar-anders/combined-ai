import { describe, expect, it } from "@jest/globals";

import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
  type Usage,
} from "../../types";
import { type ResolvedEmbedder } from "../embedding";
import { type CombineEvent } from "../index";
import { panel } from "../panel";
import { type RosterEntry } from "../shared";

type Phase = "answer" | "review" | "synth" | "sanitize";

type Call = { provider: string; phase: Phase; request: CompletionRequest };

/** Classify a phase from the shaped system prompt (mirrors the framing constants). */
function phaseOf(request: CompletionRequest): Phase {
  // Combine always forwards system as a string (its framing); coerce for the type.
  const system = typeof request.system === "string" ? request.system : "";
  if (system.includes("Rewrite the following")) return "sanitize";
  if (system.includes("integrate the complementary perspectives"))
    return "synth";
  if (system.includes("produce only a review")) return "review";
  return "answer";
}

/** Combine always builds string content, so the fakes can read it back as text. */
function firstText(request: CompletionRequest): string {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

/** The shaped system prompt of a recorded call, as a string (combine always uses one). */
function systemOf(request: CompletionRequest | undefined): string {
  const system = request?.system;
  return typeof system === "string" ? system : "";
}

/** The first user-message body of a recorded call, as a string. */
function bodyOf(request: CompletionRequest | undefined): string {
  return request === undefined ? "" : firstText(request);
}

/**
 * A network-free {@link Provider} that records every call and returns
 * `"<name>:<phase>"`, optionally throwing on `failOn` or returning empty text on
 * `emptyOn`. The sanitize phase echoes its input unchanged (a real sanitizer
 * returns the cleaned answer), unless it is the `failOn`/`emptyOn` phase.
 */
function fakeProvider(
  name: string,
  calls: Call[],
  failOn?: Phase,
  emptyOn?: Phase,
  usage?: Usage,
): Provider {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/require-await
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const phase = phaseOf(request);
      calls.push({ provider: name, phase, request });
      if (failOn === phase) {
        throw new Error(`${name} failed during ${phase}`);
      }
      const text =
        emptyOn === phase
          ? ""
          : phase === "sanitize"
            ? firstText(request)
            : `${name}:${phase}`;
      return usage === undefined
        ? { text, model: `${name}-model` }
        : { text, model: `${name}-model`, usage };
    },
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *stream(): AsyncGenerator<string, void, void> {
      throw new Error("stream is not used by panel");
    },
  };
}

const PROMPT = {
  messages: [{ role: "user" as const, content: "How should we cache this?" }],
};

/** Build a roster entry with an optional per-participant instruction. */
function entry(
  name: string,
  calls: Call[],
  opts?: {
    instruction?: string;
    failOn?: Phase;
    emptyOn?: Phase;
    usage?: Usage;
  },
): RosterEntry {
  return {
    id: name,
    providerName: name,
    provider: fakeProvider(
      name,
      calls,
      opts?.failOn,
      opts?.emptyOn,
      opts?.usage,
    ),
    ...(opts?.instruction === undefined
      ? {}
      : { instruction: opts.instruction }),
  };
}

// The anthropic/openai answers agree; gemini dissents — exercises perspectiveAgreement.
const ANSWER_VECTORS: Record<string, number[]> = {
  "anthropic:answer": [1, 0],
  "openai:answer": [1, 0],
  "gemini:answer": [0, 1],
};

function fakeEmbedder(): ResolvedEmbedder {
  const provider: Provider & { embed: NonNullable<Provider["embed"]> } = {
    name: "emb",
    complete: () => {
      throw new Error("complete not used in this test");
    },
    stream: () => {
      throw new Error("stream not used in this test");
    },
    embed: (request: EmbeddingRequest): Promise<EmbeddingResult> =>
      Promise.resolve({
        embeddings: request.input.map((text) => ANSWER_VECTORS[text] ?? [0, 0]),
        model: "embed-model",
      }),
  };
  return { name: "emb", provider };
}

describe("panel", () => {
  it("runs answer → synthesize (no review by default) across all participants", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls),
      entry("openai", calls),
      entry("gemini", calls),
    ];

    const result = await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // 3 answers + 1 synth + 1 sanitize; no reviews (crossExamine defaults off).
    expect(calls.filter((c) => c.phase === "answer")).toHaveLength(3);
    expect(calls.filter((c) => c.phase === "review")).toHaveLength(0);
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(1);
    expect(calls.filter((c) => c.phase === "sanitize")).toHaveLength(1);

    expect(result.strategy).toBe("panel");
    expect(result.synthesizer).toBe("anthropic");
    expect(result.text).toBe("anthropic:synth");
    expect(result.model).toBe("anthropic-model");
    expect(result.answers).toHaveLength(3);
    expect(result.reviews).toEqual([]);
  });

  it("composes each participant's instruction as [system] + [instruction] + [framing]", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, {
        instruction: "You are a security reviewer.",
      }),
      entry("openai", calls, {
        instruction: "You are a performance reviewer.",
      }),
    ];

    await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      system: "House style.",
    });

    const answer = calls.find(
      (c) => c.phase === "answer" && c.provider === "anthropic",
    );
    const system = systemOf(answer?.request);
    expect(system).toContain("House style.");
    expect(system).toContain("You are a security reviewer.");
    expect(system).toContain("member of an expert panel");
    // Order: caller system → role instruction → phase framing.
    expect(system.indexOf("House style.")).toBeLessThan(
      system.indexOf("You are a security reviewer."),
    );
    expect(system.indexOf("You are a security reviewer.")).toBeLessThan(
      system.indexOf("member of an expert panel"),
    );
  });

  it("integrates the synthesizer WITHOUT its own role instruction", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, { instruction: "SECRET_ROLE_ANTHROPIC" }),
      entry("openai", calls, { instruction: "SECRET_ROLE_OPENAI" }),
    ];

    await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    // anthropic answers in character...
    const answer = calls.find(
      (c) => c.phase === "answer" && c.provider === "anthropic",
    );
    expect(systemOf(answer?.request)).toContain("SECRET_ROLE_ANTHROPIC");
    // ...but integrates neutrally — no role instruction leaks into synthesis.
    const synth = calls.find((c) => c.phase === "synth");
    expect(systemOf(synth?.request)).not.toContain("SECRET_ROLE_ANTHROPIC");
    expect(systemOf(synth?.request)).toContain(
      "integrate the complementary perspectives",
    );
    // The answers are fed with attributed role headings, so the framing must also
    // forbid those role names from leaking into the user-facing answer.
    expect(systemOf(synth?.request)).toContain("do not name or attribute");
  });

  it("routes synthesis to the chosen synthesizer", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls),
      entry("openai", calls),
      entry("gemini", calls),
    ];

    const result = await panel(roster, "gemini", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
      synthesizer: "gemini",
    });

    expect(result.synthesizer).toBe("gemini");
    expect(result.text).toBe("gemini:synth");
  });

  it("falls back to the next survivor when the synthesizer fails", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, { failOn: "synth" }),
      entry("openai", calls),
    ];

    const result = await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.synthesizer).toBe("openai");
    expect(result.text).toBe("openai:synth");
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(2);
  });

  it("attributes answers by role id and feeds answers into synthesis", async () => {
    const calls: Call[] = [];
    const roster = [entry("anthropic", calls), entry("openai", calls)];

    await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    const synthBody = bodyOf(calls.find((c) => c.phase === "synth")?.request);
    expect(synthBody).toContain("## Panel answers");
    expect(synthBody).toContain("### anthropic");
    expect(synthBody).toContain("### openai");
    expect(synthBody).toContain("anthropic:answer");
    // No reviews were run, so there is no reviews block.
    expect(synthBody).not.toContain("## Reviews");
  });

  it("runs a review round and feeds reviews into synthesis when crossExamine is on", async () => {
    const calls: Call[] = [];
    const roster = [entry("anthropic", calls), entry("openai", calls)];

    await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      crossExamine: true,
    });

    // One review per survivor.
    expect(calls.filter((c) => c.phase === "review")).toHaveLength(2);
    const synthBody = bodyOf(calls.find((c) => c.phase === "synth")?.request);
    expect(synthBody).toContain("## Reviews");
    expect(synthBody).toContain("### Review from anthropic");
    expect(synthBody).toContain("anthropic:review");
  });

  it("treats a failed review as non-fatal", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, { failOn: "review" }),
      entry("openai", calls),
    ];

    const result = await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      crossExamine: true,
    });

    // Synthesis still succeeds; the failed review is recorded but not rendered.
    expect(result.text).toBe("anthropic:synth");
    expect(result.reviews.find((r) => r.id === "anthropic")?.status).toBe(
      "failed",
    );
    const synthBody = bodyOf(calls.find((c) => c.phase === "synth")?.request);
    expect(synthBody).toContain("### Review from openai");
    expect(synthBody).not.toContain("### Review from anthropic");
  });

  it("drops empty-text answers from the survivors", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, { emptyOn: "answer" }),
      entry("openai", calls),
      entry("gemini", calls),
    ];

    await panel(roster, "openai", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    const synthBody = bodyOf(calls.find((c) => c.phase === "synth")?.request);
    expect(synthBody).not.toContain("### anthropic");
    expect(synthBody).toContain("openai:answer");
    expect(synthBody).toContain("gemini:answer");
  });

  it("degrades to a single sanitized answer when only one perspective survives", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, { failOn: "answer" }),
      entry("openai", calls),
      entry("gemini", calls, { failOn: "answer" }),
    ];

    const result = await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
      crossExamine: true, // still degrades — nothing to cross-examine
    });

    // No synthesis and no review round: the lone survivor's answer is sanitized.
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(0);
    expect(calls.filter((c) => c.phase === "review")).toHaveLength(0);
    expect(calls.filter((c) => c.phase === "sanitize")).toHaveLength(1);
    expect(result.synthesizer).toBe("openai");
    expect(result.model).toBe("openai-model");
    expect(result.text).toBe("openai:answer");
    expect(result.answers).toHaveLength(3);
    expect(result.reviews).toEqual([]);
    expect(result.perspectiveAgreement).toBeUndefined();
  });

  it("throws when no participant produces an answer", async () => {
    const calls: Call[] = [];
    const roster = [
      entry("anthropic", calls, { failOn: "answer" }),
      entry("openai", calls, { failOn: "answer" }),
    ];

    await expect(
      panel(roster, "anthropic", {
        ...PROMPT,
        participants: ["anthropic", "openai"],
      }),
    ).rejects.toThrow(/no participant produced an answer/);
  });

  it("threads the abort signal into every phase's completion", async () => {
    const calls: Call[] = [];
    const roster = [entry("anthropic", calls), entry("openai", calls)];

    const controller = new AbortController();
    await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      crossExamine: true,
      signal: controller.signal,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.request.signal === controller.signal)).toBe(
      true,
    );
  });

  it("emits phase and per-participant progress events", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      entry("anthropic", calls),
      entry("openai", calls),
      entry("gemini", calls),
    ];

    await panel(
      roster,
      "anthropic",
      {
        ...PROMPT,
        participants: ["anthropic", "openai", "gemini"],
        crossExamine: true,
      },
      { onEvent: (event) => events.push(event) },
    );

    const phases = events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));
    expect(phases).toEqual(["answering", "reviewing", "synthesizing"]);
    expect(events.filter((e) => e.type === "answer")).toHaveLength(3);
    expect(events.filter((e) => e.type === "review")).toHaveLength(3);
  });

  it("aggregates token usage per participant, overall, and in the ledger", async () => {
    const calls: Call[] = [];
    const tok = (n: number): Usage => ({
      inputTokens: n,
      outputTokens: n,
      totalTokens: n * 2,
    });
    const roster = [
      entry("anthropic", calls, { usage: tok(2) }),
      entry("openai", calls, { usage: tok(1) }),
    ];

    const result = await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    // anthropic: answer + synth + sanitize = 3 calls; openai: answer = 1 call.
    expect(result.usage?.byParticipant.anthropic).toEqual(tok(6));
    expect(result.usage?.byParticipant.openai).toEqual(tok(1));
    expect(result.usage?.total).toEqual({
      inputTokens: 7,
      outputTokens: 7,
      totalTokens: 14,
    });
    expect(result.usage?.calls.every((c) => c.model.endsWith("-model"))).toBe(
      true,
    );
  });

  it("skips reviews and sanitize once the budget is spent, but still synthesizes", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const tok = (n: number): Usage => ({
      inputTokens: n,
      outputTokens: 0,
      totalTokens: n,
    });
    const cheapModels = {
      "anthropic-model": { inputPerMTok: 1, outputPerMTok: 0 },
      "openai-model": { inputPerMTok: 1, outputPerMTok: 0 },
      "gemini-model": { inputPerMTok: 1, outputPerMTok: 0 },
    };
    const roster = ["anthropic", "openai", "gemini"].map((name) =>
      entry(name, calls, { usage: tok(1_000_000) }),
    );

    const result = await panel(
      roster,
      "anthropic",
      {
        ...PROMPT,
        participants: ["anthropic", "openai", "gemini"],
        crossExamine: true,
      },
      {
        // 3 answers at $1 each = $3 > $2, so reviews are skipped before launching.
        budget: { usd: 2, models: cheapModels },
        onEvent: (event) => events.push(event),
      },
    );

    expect(calls.filter((c) => c.phase === "answer")).toHaveLength(3);
    expect(calls.filter((c) => c.phase === "review")).toHaveLength(0);
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(1);
    expect(calls.filter((c) => c.phase === "sanitize")).toHaveLength(0);
    expect(result.text).toBe("anthropic:synth");

    const skipped = events.flatMap((e) =>
      e.type === "budget" && e.skipped !== undefined ? [e.skipped] : [],
    );
    expect(skipped).toEqual(["reviews", "sanitize"]);
  });

  it("attaches an informational perspectiveAgreement when an embedder is given", async () => {
    const calls: Call[] = [];
    const roster = (["anthropic", "openai", "gemini"] as const).map((name) =>
      entry(name, calls),
    );

    const result = await panel(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      undefined,
      fakeEmbedder(),
    );

    // The synthesized answer is unchanged by the signal.
    expect(result.text).toBe("anthropic:synth");
    expect(result.perspectiveAgreement?.agreement).toBeCloseTo(1 / 3);
    expect(result.perspectiveAgreement?.outlier).toBe("gemini");
  });

  it("omits perspectiveAgreement when no embedder is configured", async () => {
    const calls: Call[] = [];
    const roster = [entry("anthropic", calls), entry("openai", calls)];

    const result = await panel(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.perspectiveAgreement).toBeUndefined();
  });

  it("supports the same provider twice with different instructions", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "optimist",
        providerName: "openai" as const,
        provider: fakeProvider("optimist", calls),
        instruction: "You are an optimist.",
      },
      {
        id: "skeptic",
        providerName: "openai" as const,
        provider: fakeProvider("skeptic", calls),
        instruction: "You are a skeptic.",
      },
    ];

    const result = await panel(roster, "optimist", {
      ...PROMPT,
      participants: [
        {
          provider: "openai",
          label: "optimist",
          instruction: "You are an optimist.",
        },
        {
          provider: "openai",
          label: "skeptic",
          instruction: "You are a skeptic.",
        },
      ],
    });

    expect(result.answers.map((a) => a.id)).toEqual(["optimist", "skeptic"]);
    expect(result.answers.every((a) => a.provider === "openai")).toBe(true);
    expect(result.synthesizer).toBe("optimist");
  });
});
