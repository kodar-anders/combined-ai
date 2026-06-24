import { describe, expect, it } from "@jest/globals";

import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
  type Usage,
} from "../../types";
import { consensus } from "../consensus";
import { type ResolvedEmbedder } from "../embedding";
import { type CombineEvent } from "../index";

type Phase = "draft" | "critique" | "synth" | "sanitize";

type Call = { provider: string; phase: Phase; request: CompletionRequest };

/** Classify a phase from the shaped system prompt (mirrors the framing constants). */
function phaseOf(request: CompletionRequest): Phase {
  const system = request.system ?? "";
  if (system.includes("Rewrite the following")) return "sanitize";
  if (system.includes("lead assistant")) return "synth";
  if (system.includes("produce only a critique")) return "critique";
  return "draft";
}

/** Combine always builds string content, so the fakes can read it back as text. */
function firstText(request: CompletionRequest): string {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
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
      // An empty response is still a billed call, so it carries usage when set.
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
      throw new Error("stream is not used by consensus");
    },
  };
}

const PROMPT: CompletionRequest = {
  messages: [{ role: "user", content: "What is 2 + 2?" }],
};

// Maps a draft text to a 2-D vector: the anthropic/openai drafts agree, gemini
// dissents. Used to exercise the optional draftAgreement signal.
const DRAFT_VECTORS: Record<string, number[]> = {
  "anthropic:draft": [1, 0],
  "openai:draft": [1, 0],
  "gemini:draft": [0, 1],
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
        embeddings: request.input.map((text) => DRAFT_VECTORS[text] ?? [0, 0]),
        model: "embed-model",
      }),
  };
  return { name: "emb", provider };
}

describe("consensus", () => {
  it("runs draft → critique → synthesis across all participants", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // 3 drafts + 3 critiques + 1 synthesis.
    expect(calls.filter((c) => c.phase === "draft")).toHaveLength(3);
    expect(calls.filter((c) => c.phase === "critique")).toHaveLength(3);
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(1);

    // Default synthesizer is the first participant.
    expect(result.synthesizer).toBe("anthropic");
    expect(result.text).toBe("anthropic:synth");
    expect(result.model).toBe("anthropic-model");
    expect(result.strategy).toBe("consensus");
    expect(result.drafts).toHaveLength(3);
    expect(result.critiques).toHaveLength(3);
    expect(result.drafts.every((d) => d.status === "ok")).toBe(true);
  });

  it("threads the abort signal into every phase's completion", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const controller = new AbortController();
    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      signal: controller.signal,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.request.signal === controller.signal)).toBe(
      true,
    );
  });

  it("feeds attributed drafts into critique and drafts + critiques into synthesis", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      attribution: "attributed",
    });

    const critique = calls.find((c) => c.phase === "critique");
    const critiqueBody = critique?.request.messages[0]?.content ?? "";
    expect(critiqueBody).toContain("### Answer from anthropic");
    expect(critiqueBody).toContain("### Answer from openai");
    expect(critiqueBody).toContain("anthropic:draft");
    expect(critiqueBody).toContain("openai:draft");

    const synth = calls.find((c) => c.phase === "synth");
    const synthBody = synth?.request.messages[0]?.content ?? "";
    expect(synthBody).toContain("## Drafts");
    expect(synthBody).toContain("## Critiques");
    expect(synthBody).toContain("### Critique from anthropic");
    expect(synthBody).toContain("anthropic:critique");
    expect(synth?.request.system).toContain("lead assistant");
    expect(synth?.request.system).toContain("do not");
  });

  it("anonymizes draft headings by default", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    const critiqueBody =
      calls.find((c) => c.phase === "critique")?.request.messages[0]?.content ??
      "";
    expect(critiqueBody).toContain("### Answer A");
    expect(critiqueBody).toContain("### Answer B");
    expect(critiqueBody).not.toContain("Answer from anthropic");
  });

  it("routes synthesis to the chosen synthesizer", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    const result = await consensus(roster, "gemini", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
      synthesizer: "gemini",
    });

    expect(result.synthesizer).toBe("gemini");
    expect(result.text).toBe("gemini:synth");
  });

  it("threads the caller's system prompt into every phase", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      system: "You are a calm mathematician.",
    });

    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      expect(call.request.system).toContain("You are a calm mathematician.");
    }
    // The caller's system is prepended to the draft's conciseness directive.
    const draftSystem = calls.find((c) => c.phase === "draft")?.request.system;
    expect(draftSystem).toContain("You are a calm mathematician.");
    expect(draftSystem).toContain("greetings");
  });

  it("tells the draft and critique phases to omit greetings and filler, but not the synthesis", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(calls.find((c) => c.phase === "draft")?.request.system).toContain(
      "greetings",
    );
    expect(calls.find((c) => c.phase === "critique")?.request.system).toContain(
      "greetings",
    );
    // The synthesis is the user-facing answer, so it is not constrained to be terse.
    expect(
      calls.find((c) => c.phase === "synth")?.request.system,
    ).not.toContain("greetings");
  });

  it("asks critics for a structured verdict and tells the synthesizer to favor correctness over consensus", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    const critiqueSystem =
      calls.find((c) => c.phase === "critique")?.request.system ?? "";
    expect(critiqueSystem).toContain("BEST:");
    expect(critiqueSystem).toContain("CONFIDENCE:");

    const synthSystem =
      calls.find((c) => c.phase === "synth")?.request.system ?? "";
    expect(synthSystem).toContain("correctness over popularity");
    expect(synthSystem).toContain("must not favor");
    // The synthesizer is told never to leak the internal draft labels/process.
    expect(synthSystem).toContain('"candidates"');
  });

  it("runs a sanitizing pass over the synthesized answer", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    const sanitize = calls.find((c) => c.phase === "sanitize");
    expect(sanitize).toBeDefined();
    // The sanitizer receives the raw synthesized answer as its input...
    expect(sanitize?.request.messages[0]?.content).toBe("anthropic:synth");
    // ...and its (echoed) output is what combine returns.
    expect(result.text).toBe("anthropic:synth");
  });

  it("returns the raw synthesis when the sanitizing pass fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        // Drafts/critiques/synth succeed; only the sanitize pass throws.
        provider: fakeProvider("anthropic", calls, "sanitize"),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.text).toBe("anthropic:synth");
  });

  it("continues with survivors when a participant fails to draft", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "draft"),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    const anthropicDraft = result.drafts.find(
      (d) => d.provider === "anthropic",
    );
    expect(anthropicDraft?.status).toBe("failed");
    // Only the two survivors critique, and the failed draft is absent from the body.
    expect(calls.filter((c) => c.phase === "critique")).toHaveLength(2);
    const synthBody =
      calls.find((c) => c.phase === "synth")?.request.messages[0]?.content ??
      "";
    expect(synthBody).not.toContain("anthropic:draft");
    // The chosen synthesizer failed phase 1, so it falls back to a survivor.
    expect(result.synthesizer).toBe("openai");
  });

  it("drops empty-text drafts from the survivors", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        // Resolves successfully but with an empty draft.
        provider: fakeProvider("anthropic", calls, undefined, "draft"),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    await consensus(roster, "openai", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // The empty draft is excluded: only the two non-empty survivors critique...
    expect(calls.filter((c) => c.phase === "critique")).toHaveLength(2);
    // ...and the blank answer is never rendered into the critique/synthesis body.
    const critiqueBody =
      calls.find((c) => c.phase === "critique")?.request.messages[0]?.content ??
      "";
    expect(critiqueBody).not.toContain("Answer from anthropic");
    expect(critiqueBody).toContain("openai:draft");
    expect(critiqueBody).toContain("gemini:draft");
  });

  it("counts an empty draft as a non-survivor for minParticipants", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, undefined, "draft"),
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, "draft"),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    await expect(
      consensus(roster, "gemini", {
        ...PROMPT,
        participants: ["anthropic", "openai", "gemini"],
      }),
    ).rejects.toThrow(/only 1 of 3/);
  });

  it("throws when fewer than minParticipants produce a draft", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "draft"),
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, "draft"),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    await expect(
      consensus(roster, "anthropic", {
        ...PROMPT,
        participants: ["anthropic", "openai", "gemini"],
      }),
    ).rejects.toThrow(/only 1 of 3/);
  });

  it("degrades to a plain completion for a single participant", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.phase).toBe("draft");
    expect(result.text).toBe("anthropic:draft");
    expect(result.critiques).toEqual([]);
  });

  it("falls back to the next survivor when the synthesizer fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "synth"),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.synthesizer).toBe("openai");
    expect(result.text).toBe("openai:synth");
    // Two synthesis attempts: the chosen one (failed) then the fallback.
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(2);
  });

  it("falls back when the synthesizer resolves with empty text", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        // Resolves successfully but with empty synthesis output.
        provider: fakeProvider("anthropic", calls, undefined, "synth"),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.synthesizer).toBe("openai");
    expect(result.text).toBe("openai:synth");
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(2);
  });

  it("counts a billed-but-empty synthesis attempt in the aggregated usage", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        // Synthesis resolves empty (still a billed call) and falls back to openai.
        provider: fakeProvider("anthropic", calls, undefined, "synth", {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        }),
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, undefined, {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.synthesizer).toBe("openai");
    // anthropic makes 3 billed calls (draft, critique, empty synth) — the empty
    // synth must still be counted; openai makes 4 (draft, critique, synth, sanitize).
    expect(result.usage?.byParticipant.anthropic).toEqual({
      inputTokens: 6,
      outputTokens: 9,
      totalTokens: 15,
    });
    expect(result.usage?.byParticipant.openai).toEqual({
      inputTokens: 4,
      outputTokens: 4,
      totalTokens: 8,
    });
    expect(result.usage?.total).toEqual({
      inputTokens: 10,
      outputTokens: 13,
      totalTokens: 23,
    });
  });

  it("keeps anonymized critique letters aligned with answer letters when a middle critique fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai" as const,
        // openai drafts fine but its critique fails, compacting the critique list.
        provider: fakeProvider("openai", calls, "critique"),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
      attribution: "anonymized",
    });

    const synthBody =
      calls.find((c) => c.phase === "synth")?.request.messages[0]?.content ??
      "";
    // gemini is "Answer C"; its critique must be labelled "Critique C", not "Critique B".
    expect(synthBody).toContain("### Critique C");
    expect(synthBody).toContain("gemini:critique");
    // openai (Answer B) failed its critique, so there is no "Critique B".
    expect(synthBody).not.toContain("### Critique B");
  });

  it("aggregates token usage per participant and overall", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, undefined, undefined, {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        }),
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, undefined, {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    // anthropic makes 4 calls (draft, critique, synth, sanitize); openai 2 (draft, critique).
    expect(result.usage?.byParticipant.anthropic).toEqual({
      inputTokens: 8,
      outputTokens: 12,
      totalTokens: 20,
    });
    expect(result.usage?.byParticipant.openai).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
    });
    expect(result.usage?.total).toEqual({
      inputTokens: 10,
      outputTokens: 14,
      totalTokens: 24,
    });
  });

  it("leaves usage undefined when no provider reports it", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.usage).toBeUndefined();
  });

  it("emits phase and per-participant progress events", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    // Each phase is announced once, in order.
    const phases = events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));
    expect(phases).toEqual(["drafting", "critiquing", "synthesizing"]);

    // One draft and one critique event per participant.
    const draftProviders = events.flatMap((e) =>
      e.type === "draft" ? [e.provider] : [],
    );
    expect(draftProviders).toHaveLength(3);
    expect(new Set(draftProviders)).toEqual(
      new Set(["anthropic", "openai", "gemini"]),
    );
    expect(events.filter((e) => e.type === "critique")).toHaveLength(3);
  });

  it("reports a failed participant in its progress event", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "draft"),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
      {
        id: "gemini",
        providerName: "gemini" as const,
        provider: fakeProvider("gemini", calls),
      },
    ];

    await consensus(
      roster,
      "openai",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    const failed = events.flatMap((e) =>
      e.type === "draft" && e.status === "failed" ? [e.provider] : [],
    );
    expect(failed).toEqual(["anthropic"]);
  });

  it("emits only drafting events for a single-participant combine", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
    ];

    await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic"] },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(events).toEqual([
      { type: "phase", phase: "drafting" },
      { type: "draft", id: "anthropic", provider: "anthropic", status: "ok" },
    ]);
  });

  it("swallows errors thrown by the progress handler", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        id: "openai",
        providerName: "openai",
        provider: fakeProvider("openai", calls),
      },
    ];

    const result = await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai"] },
      {
        onEvent: () => {
          throw new Error("listener boom");
        },
      },
    );

    expect(result.text).toBe("anthropic:synth");
  });

  it("applies each participant's model/maxTokens override to its own calls", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
        model: "claude-x",
        maxTokens: 111,
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls),
        model: "gpt-x",
        maxTokens: 222,
      },
    ];

    await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      maxTokens: 999, // request-wide fallback, overridden per participant below
    });

    // anthropic synthesizes, so it makes draft + critique + synth + sanitize calls,
    // every one carrying its own override (not the request-wide maxTokens).
    const anthropicCalls = calls.filter((c) => c.provider === "anthropic");
    expect(anthropicCalls.length).toBeGreaterThan(1);
    expect(anthropicCalls.every((c) => c.request.model === "claude-x")).toBe(
      true,
    );
    expect(anthropicCalls.every((c) => c.request.maxTokens === 111)).toBe(true);

    const openaiCalls = calls.filter((c) => c.provider === "openai");
    expect(openaiCalls.every((c) => c.request.model === "gpt-x")).toBe(true);
    expect(openaiCalls.every((c) => c.request.maxTokens === 222)).toBe(true);
  });

  it("supports two participants on the same provider with distinct ids", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "gemini-flash",
        providerName: "gemini" as const,
        provider: fakeProvider("flash", calls),
        model: "gemini-2.5-flash",
      },
      {
        id: "gemini-pro",
        providerName: "gemini" as const,
        provider: fakeProvider("pro", calls),
        model: "gemini-2.5-pro",
      },
    ];

    const result = await consensus(roster, "gemini-pro", {
      ...PROMPT,
      participants: [
        { provider: "gemini", model: "gemini-2.5-flash" },
        { provider: "gemini", model: "gemini-2.5-pro" },
      ],
    });

    // Both drafts are tagged by their participant id, but report the same provider.
    expect(result.drafts.map((d) => d.id)).toEqual([
      "gemini-flash",
      "gemini-pro",
    ]);
    expect(result.drafts.every((d) => d.provider === "gemini")).toBe(true);
    // The id-named synthesizer (the "pro" participant) wrote the final answer.
    expect(result.synthesizer).toBe("gemini-pro");
    expect(result.text).toBe("pro:synth");
  });
});

describe("consensus cost ledger + budget", () => {
  const tok = (n: number): Usage => ({
    inputTokens: n,
    outputTokens: 0,
    totalTokens: n,
  });

  /** Price every fake `<name>-model` at $1 per the call's input MTok. */
  const cheapModels = {
    "anthropic-model": { inputPerMTok: 1, outputPerMTok: 0 },
    "openai-model": { inputPerMTok: 1, outputPerMTok: 0 },
    "gemini-model": { inputPerMTok: 1, outputPerMTok: 0 },
  };

  it("records every billed call (incl. a discarded empty-synth attempt) in usage.calls", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        // anthropic is the synthesizer but its synth is empty → falls back to openai.
        provider: fakeProvider("anthropic", calls, undefined, "synth", tok(10)),
      },
      {
        id: "openai",
        providerName: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, undefined, tok(10)),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.synthesizer).toBe("openai");
    // anthropic: draft + critique + discarded empty synth = 3 ledger entries.
    expect(
      result.usage?.calls.filter((c) => c.id === "anthropic"),
    ).toHaveLength(3);
    // openai: draft + critique + synth + sanitize = 4.
    expect(result.usage?.calls.filter((c) => c.id === "openai")).toHaveLength(
      4,
    );
    // Every ledger entry carries the model that made it.
    expect(result.usage?.calls.every((c) => c.model.endsWith("-model"))).toBe(
      true,
    );
  });

  it("populates the ledger on the single-provider early-return path", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        id: "anthropic",
        providerName: "anthropic" as const,
        provider: fakeProvider(
          "anthropic",
          calls,
          undefined,
          undefined,
          tok(5),
        ),
      },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic"],
    });

    // A single-provider combine is just the one draft — one ledger entry.
    expect(result.usage?.calls).toEqual([
      { id: "anthropic", model: "anthropic-model", usage: tok(5) },
    ]);
  });

  it("skips critiques and sanitize once the budget is spent, but still synthesizes", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = ["anthropic", "openai", "gemini"].map((name) => ({
      id: name,
      providerName: name as "anthropic" | "openai" | "gemini",
      provider: fakeProvider(name, calls, undefined, undefined, tok(1_000_000)),
    }));

    const result = await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      {
        // 3 drafts at $1 each = $3 > $2, so critiques are skipped before launching.
        budget: { usd: 2, models: cheapModels },
        onEvent: (event) => events.push(event),
      },
    );

    expect(calls.filter((c) => c.phase === "draft")).toHaveLength(3);
    expect(calls.filter((c) => c.phase === "critique")).toHaveLength(0);
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(1);
    expect(calls.filter((c) => c.phase === "sanitize")).toHaveLength(0);
    // Synthesis still produced an answer (a budget never leaves the run empty).
    expect(result.text).toBe("anthropic:synth");

    const skipped = events.flatMap((e) =>
      e.type === "budget" && e.skipped !== undefined ? [e.skipped] : [],
    );
    expect(skipped).toEqual(["critiques", "sanitize"]);
  });

  it("runs every phase when the budget is generous", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = ["anthropic", "openai"].map((name) => ({
      id: name,
      providerName: name as "anthropic" | "openai",
      provider: fakeProvider(name, calls, undefined, undefined, tok(1_000_000)),
    }));

    await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai"] },
      {
        budget: { usd: 1000, models: cheapModels },
        onEvent: (event) => events.push(event),
      },
    );

    expect(calls.filter((c) => c.phase === "critique")).toHaveLength(2);
    expect(calls.filter((c) => c.phase === "sanitize")).toHaveLength(1);
    expect(events.filter((e) => e.type === "budget")).toHaveLength(0);
  });

  it("warns once and enforces nothing when no call can be priced", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = ["anthropic", "openai"].map((name) => ({
      id: name,
      providerName: name as "anthropic" | "openai",
      provider: fakeProvider(name, calls, undefined, undefined, tok(1_000_000)),
    }));

    await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai"] },
      // No `models`, so the fake `<name>-model`s can't be priced → budget is inert.
      { budget: { usd: 0.000_001 }, onEvent: (event) => events.push(event) },
    );

    // The budget couldn't enforce, so every phase ran.
    expect(calls.filter((c) => c.phase === "critique")).toHaveLength(2);
    expect(calls.filter((c) => c.phase === "sanitize")).toHaveLength(1);
    // Exactly one under-enforced warning, and no skip events.
    const budgetEvents = events.flatMap((e) =>
      e.type === "budget" ? [e] : [],
    );
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]?.underEnforced).toBe(true);
    expect(budgetEvents[0]?.skipped).toBeUndefined();
  });

  it("attaches an informational draftAgreement when an embedder is given", async () => {
    const calls: Call[] = [];
    const roster = (["anthropic", "openai", "gemini"] as const).map((name) => ({
      id: name,
      providerName: name,
      provider: fakeProvider(name, calls),
    }));

    const result = await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      undefined,
      fakeEmbedder(),
    );

    // The synthesized answer is unchanged by the signal.
    expect(result.text).toBe("anthropic:synth");
    expect(result.draftAgreement?.agreement).toBeCloseTo(1 / 3);
    expect(result.draftAgreement?.outlier).toBe("gemini");
    expect(result.draftAgreement?.clusters).toEqual([
      ["anthropic", "openai"],
      ["gemini"],
    ]);
  });

  it("omits draftAgreement when no embedder is configured", async () => {
    const calls: Call[] = [];
    const roster = (["anthropic", "openai"] as const).map((name) => ({
      id: name,
      providerName: name,
      provider: fakeProvider(name, calls),
    }));

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.draftAgreement).toBeUndefined();
  });
});
