import { describe, expect, it } from "@jest/globals";

import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type Usage,
} from "../../types";
import { type CombineEvent } from "../index";
import { pipeline } from "../pipeline";

type Phase = "first" | "refine" | "sanitize";

type Call = { provider: string; phase: Phase; request: CompletionRequest };

/** Classify a phase from the shaped system prompt (mirrors the framing constants). */
function phaseOf(request: CompletionRequest): Phase {
  const system = request.system ?? "";
  if (system.includes("Rewrite the following")) return "sanitize";
  if (system.includes("revise the current answer")) return "refine";
  return "first";
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
      if (emptyOn === phase) {
        return { text: "", model: `${name}-model` };
      }
      const text =
        phase === "sanitize"
          ? (request.messages[0]?.content ?? "")
          : `${name}:${phase}`;
      return usage === undefined
        ? { text, model: `${name}-model` }
        : { text, model: `${name}-model`, usage };
    },
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *stream(): AsyncGenerator<string, void, void> {
      throw new Error("stream is not used by pipeline");
    },
  };
}

const PROMPT: CompletionRequest = {
  messages: [{ role: "user", content: "What is 2 + 2?" }],
};

describe("pipeline", () => {
  it("runs stages in order: first answer, then refinements, last stage wins", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // Only the first stage uses the first-stage framing; the rest refine.
    expect(calls.filter((c) => c.phase === "first")).toHaveLength(1);
    expect(calls.filter((c) => c.phase === "refine")).toHaveLength(2);
    // First stage is the first participant.
    expect(calls[0]?.provider).toBe("anthropic");
    expect(calls[0]?.phase).toBe("first");

    expect(result.strategy).toBe("pipeline");
    // gemini refined last, so its output (after sanitize echo) is the final answer.
    expect(result.finalProvider).toBe("gemini");
    expect(result.model).toBe("gemini-model");
    expect(result.text).toBe("gemini:refine");
    expect(result.stages).toHaveLength(3);
    expect(result.stages.every((s) => s.status === "ok")).toBe(true);
  });

  it("hands the running answer to the next stage under '## Current answer'", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
    ];

    await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    const refine = calls.find((c) => c.phase === "refine");
    const body = refine?.request.messages[0]?.content ?? "";
    expect(body).toContain("## Question");
    expect(body).toContain("What is 2 + 2?");
    expect(body).toContain("## Current answer");
    // openai refines anthropic's first-stage answer.
    expect(body).toContain("anthropic:first");
  });

  it("threads the caller's system prompt into every stage", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
    ];

    await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
      system: "You are a calm mathematician.",
    });

    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      expect(call.request.system).toContain("You are a calm mathematician.");
    }
  });

  it("degrades to a plain completion for a single participant (no sanitize)", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.phase).toBe("first");
    expect(result.finalProvider).toBe("anthropic");
    expect(result.text).toBe("anthropic:first");
  });

  it("aggregates token usage per participant and overall, including the sanitize call", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, undefined, undefined, {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        }),
      },
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, undefined, {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    // anthropic writes the first answer (1 call); openai refines then sanitizes (2 calls).
    expect(result.usage?.byParticipant.anthropic).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
    expect(result.usage?.byParticipant.openai).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
    });
    expect(result.usage?.total).toEqual({
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    });
  });

  it("leaves usage undefined when no provider reports it", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.usage).toBeUndefined();
  });

  it("starts the pipeline at the first stage that produces an answer", async () => {
    const calls: Call[] = [];
    const roster = [
      // The first participant fails, so the second must run as the first stage.
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "first"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // openai ran the first-stage framing (anthropic failed before any answer existed).
    const openaiCall = calls.find((c) => c.provider === "openai");
    expect(openaiCall?.phase).toBe("first");
    // gemini then refined openai's answer.
    const geminiCall = calls.find((c) => c.provider === "gemini");
    expect(geminiCall?.phase).toBe("refine");
    expect(geminiCall?.request.messages[0]?.content).toContain("openai:first");

    expect(result.stages[0]?.status).toBe("failed");
    expect(result.finalProvider).toBe("gemini");
    expect(result.text).toBe("gemini:refine");
  });

  it("carries the previous answer forward when a middle stage fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      // openai fails its refine, so its (absent) output must not carry forward.
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, "refine"),
      },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // gemini refines anthropic's answer (openai's failed refine is skipped).
    const geminiCall = calls.find((c) => c.provider === "gemini");
    expect(geminiCall?.request.messages[0]?.content).toContain(
      "anthropic:first",
    );
    expect(geminiCall?.request.messages[0]?.content).not.toContain("openai");

    const openaiStage = result.stages.find((s) => s.provider === "openai");
    expect(openaiStage?.status).toBe("failed");
    expect(result.finalProvider).toBe("gemini");
  });

  it("does not advance the running answer on an empty (but successful) stage", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      // openai returns empty text from its refine: it succeeds but contributes nothing.
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, undefined, "refine"),
      },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    // gemini refines anthropic's answer, not openai's empty output.
    const geminiCall = calls.find((c) => c.provider === "gemini");
    expect(geminiCall?.request.messages[0]?.content).toContain(
      "anthropic:first",
    );
    expect(result.finalProvider).toBe("gemini");
  });

  it("keeps the last successful answer when the final stage fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      // openai refines fine; gemini (last) fails, so openai's answer is final.
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      {
        name: "gemini" as const,
        provider: fakeProvider("gemini", calls, "refine"),
      },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai", "gemini"],
    });

    expect(result.stages.find((s) => s.provider === "gemini")?.status).toBe(
      "failed",
    );
    expect(result.finalProvider).toBe("openai");
    expect(result.model).toBe("openai-model");
    expect(result.text).toBe("openai:refine");
  });

  it("throws when no participant produces an answer", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "first"),
      },
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, "first"),
      },
    ];

    await expect(
      pipeline(roster, {
        ...PROMPT,
        participants: ["anthropic", "openai"],
      }),
    ).rejects.toThrow(/no participant produced an answer/);
  });

  it("sanitizes the final answer when it came from a refining stage", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    const sanitize = calls.find((c) => c.phase === "sanitize");
    expect(sanitize).toBeDefined();
    // The sanitizer (run by the final stage's provider) receives the refined answer...
    expect(sanitize?.provider).toBe("openai");
    expect(sanitize?.request.messages[0]?.content).toBe("openai:refine");
    // ...and its (echoed) output is what pipeline returns.
    expect(result.text).toBe("openai:refine");
  });

  it("returns the raw refined answer when the sanitizing pass fails", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      // openai refines fine but its sanitize pass throws.
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, "sanitize"),
      },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(result.text).toBe("openai:refine");
  });

  it("does not sanitize when only the first stage produced an answer", async () => {
    const calls: Call[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      // openai's refine fails, so anthropic's first-stage answer is final.
      {
        name: "openai" as const,
        provider: fakeProvider("openai", calls, "refine"),
      },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    expect(calls.find((c) => c.phase === "sanitize")).toBeUndefined();
    expect(result.finalProvider).toBe("anthropic");
    expect(result.text).toBe("anthropic:first");
  });

  it("does not sanitize when a refining stage returns the answer unchanged", async () => {
    const calls: Call[] = [];
    // openai's refine echoes the current answer verbatim (a no-op refinement);
    // since it changed nothing, there's no process narration to strip.
    const echoRefine: Provider = {
      name: "openai",
      // eslint-disable-next-line @typescript-eslint/require-await
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        const phase = phaseOf(request);
        calls.push({ provider: "openai", phase, request });
        if (phase === "refine") {
          const body = request.messages[0]?.content ?? "";
          const marker = "## Current answer\n";
          return {
            text: body.slice(body.indexOf(marker) + marker.length),
            model: "openai-model",
          };
        }
        return { text: `openai:${phase}`, model: "openai-model" };
      },
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      async *stream(): AsyncGenerator<string, void, void> {
        throw new Error("stream is not used by pipeline");
      },
    };
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls),
      },
      { name: "openai" as const, provider: echoRefine },
    ];

    const result = await pipeline(roster, {
      ...PROMPT,
      participants: ["anthropic", "openai"],
    });

    // openai advanced (it's the final provider) but the text is unchanged, so the
    // wasted sanitizing call is skipped and the original answer is returned.
    expect(calls.find((c) => c.phase === "sanitize")).toBeUndefined();
    expect(result.finalProvider).toBe("openai");
    expect(result.text).toBe("anthropic:first");
  });

  it("emits a stage event per participant with its index and status", async () => {
    const calls: Call[] = [];
    const events: CombineEvent[] = [];
    const roster = [
      {
        name: "anthropic" as const,
        provider: fakeProvider("anthropic", calls, "first"),
      },
      { name: "openai" as const, provider: fakeProvider("openai", calls) },
      { name: "gemini" as const, provider: fakeProvider("gemini", calls) },
    ];

    await pipeline(
      roster,
      { ...PROMPT, participants: ["anthropic", "openai", "gemini"] },
      (event) => {
        events.push(event);
      },
    );

    const stages = events.flatMap((e) => (e.type === "stage" ? [e] : []));
    expect(stages).toEqual([
      { type: "stage", provider: "anthropic", status: "failed", index: 0 },
      { type: "stage", provider: "openai", status: "ok", index: 1 },
      { type: "stage", provider: "gemini", status: "ok", index: 2 },
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

    const result = await pipeline(
      roster,
      { ...PROMPT, participants: ["anthropic", "openai"] },
      () => {
        throw new Error("listener boom");
      },
    );

    expect(result.text).toBe("openai:refine");
  });
});
