import { describe, expect, it } from "@jest/globals";

import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from "../../types";
import { consensus } from "../consensus";
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
      if (emptyOn === phase) {
        return { text: "", model: `${name}-model` };
      }
      const text =
        phase === "sanitize"
          ? (request.messages[0]?.content ?? "")
          : `${name}:${phase}`;
      return { text, model: `${name}-model` };
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

describe("consensus", () => {
  it("runs draft → critique → synthesis across all participants", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        // Drafts/critiques/synth succeed; only the sanitize pass throws.
        provider: fakeProvider("anthropic", calls, "sanitize"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "draft"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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
        name: "anthropic" as const,
        // Resolves successfully but with an empty draft.
        provider: fakeProvider("anthropic", calls, undefined, "draft"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, undefined, "draft"),
      },
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, "draft"),
      },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "draft"),
      },
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, "draft"),
      },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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
        name: "anthropic" as const,
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "synth"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
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
        name: "anthropic" as const,
        // Resolves successfully but with empty synthesis output.
        provider: fakeProvider("anthropic", calls, undefined, "synth"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
    ];

    const result = await consensus(roster, "anthropic", {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.synthesizer).toBe("openai");
    expect(result.text).toBe("openai:synth");
    expect(calls.filter((c) => c.phase === "synth")).toHaveLength(2);
  });

  it("keeps anonymized critique letters aligned with answer letters when a middle critique fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      {
        name: "openai" as const,
        // openai drafts fine but its critique fails, compacting the critique list.
        provider: fakeProvider("openai", calls, "critique"),
      },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
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

  it("emits phase and per-participant progress events", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      (event) => {
        events.push(event);
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "draft"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    await consensus(
      roster,
      "openai",
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      (event) => {
        events.push(event);
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
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
    ];

    await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic"] },
      (event) => {
        events.push(event);
      },
    );

    expect(events).toEqual([
      { type: "phase", phase: "drafting" },
      { type: "draft", provider: "anthropic", status: "ok" },
    ]);
  });

  it("swallows errors thrown by the progress handler", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
    ];

    const result = await consensus(
      roster,
      "anthropic",
      { ...PROMPT, participants: ["anthropic", "openai"] },
      () => {
        throw new Error("listener boom");
      },
    );

    expect(result.text).toBe("anthropic:synth");
  });
});
