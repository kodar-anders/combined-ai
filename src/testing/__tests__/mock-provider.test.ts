import { describe, expect, it } from "@jest/globals";

import { ProviderError } from "../../errors";
import { ProviderRegistry } from "../../registry";
import { type CompletionRequest } from "../../types";
import { MockProvider } from "../mock-provider";

const PROMPT: CompletionRequest = {
  messages: [{ role: "user", content: "What is 2 + 2?" }],
};

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of stream) out.push(delta);
  return out;
}

/** `complete()` then read `.text` — keeps `unicorn/no-await-expression-member` happy. */
async function completeText(
  mock: MockProvider,
  request: CompletionRequest = PROMPT,
): Promise<string> {
  const result = await mock.complete(request);
  return result.text;
}

/** Concatenate all stream deltas back into one string. */
async function streamText(
  mock: MockProvider,
  request: CompletionRequest = PROMPT,
): Promise<string> {
  const deltas = await collect(mock.stream(request));
  return deltas.join("");
}

describe("MockProvider — complete()", () => {
  it("returns a static string response with the default model", async () => {
    const mock = new MockProvider({ response: "hello" });
    await expect(mock.complete(PROMPT)).resolves.toEqual({
      text: "hello",
      model: "mock-model",
    });
  });

  it("backfills text and model on a partial response, passing other fields through", async () => {
    const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
    const withoutText = new MockProvider({
      response: { finishReason: "length" },
    });
    await expect(withoutText.complete(PROMPT)).resolves.toEqual({
      text: "",
      model: "mock-model",
      finishReason: "length",
    });

    const rich = new MockProvider({
      model: "m-1",
      response: {
        text: "{}",
        usage,
        parsed: { a: 1 },
        finishReason: "stop",
        toolCalls: [{ name: "t", input: {} }],
      },
    });
    await expect(rich.complete(PROMPT)).resolves.toEqual({
      text: "{}",
      model: "m-1",
      usage,
      parsed: { a: 1 },
      finishReason: "stop",
      toolCalls: [{ name: "t", input: {} }],
    });
  });

  it("consumes a scripted array in order and throws a named error when exhausted", async () => {
    const mock = new MockProvider({ name: "seq", response: ["a", "b"] });
    expect(await completeText(mock)).toBe("a");
    expect(await completeText(mock)).toBe("b");
    await expect(mock.complete(PROMPT)).rejects.toThrow(
      /MockProvider "seq": scripted response exhausted at call 2 \(2 provided\)/,
    );
  });

  it("calls a responder with the request and a 0-based call index", async () => {
    const seen: number[] = [];
    const mock = new MockProvider({
      response: (request, index) => {
        seen.push(index);
        expect(request).toBe(PROMPT);
        return `#${String(index)}`;
      },
    });
    expect(await completeText(mock)).toBe("#0");
    expect(await completeText(mock)).toBe("#1");
    expect(seen).toEqual([0, 1]);
  });

  it("propagates a throwing responder and thrown Error responses", async () => {
    const boom = new Error("boom");
    const thrower = new MockProvider({
      response: () => {
        throw boom;
      },
    });
    await expect(thrower.complete(PROMPT)).rejects.toBe(boom);

    const err = new ProviderError("rate limited", {
      provider: "mock",
      kind: "api",
      status: 429,
    });
    const scripted = new MockProvider({ response: ["ok", err] });
    expect(await completeText(scripted)).toBe("ok");
    await expect(scripted.complete(PROMPT)).rejects.toBe(err);
  });
});

describe("MockProvider — stream()", () => {
  it("splits text losslessly by default across whitespace edge cases", async () => {
    for (const text of [
      "hello",
      " leading",
      "trailing ",
      "a  b",
      "line1\nline2",
      "single",
    ]) {
      const mock = new MockProvider({ response: text });
      expect(await streamText(mock)).toBe(text);
    }
  });

  it("yields no deltas for empty text", async () => {
    const mock = new MockProvider({ response: "" });
    await expect(collect(mock.stream(PROMPT))).resolves.toEqual([]);
  });

  it("honors a custom chunk function", async () => {
    const mock = new MockProvider({
      response: "abcdef",
      chunk: (t) => t.match(/.{1,2}/gs) ?? [],
    });
    await expect(collect(mock.stream(PROMPT))).resolves.toEqual([
      "ab",
      "cd",
      "ef",
    ]);
  });

  it("advances the same cursor and records calls as complete()", async () => {
    const mock = new MockProvider({ response: ["one", "two"] });
    expect(await streamText(mock)).toBe("one");
    expect(await completeText(mock)).toBe("two");
    expect(mock.calls).toHaveLength(2);
  });
});

describe("MockProvider — signals", () => {
  it("throws a transport ProviderError when already aborted (complete + stream entry)", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = new MockProvider({ response: "x" });
    const aborted = { ...PROMPT, signal: controller.signal };

    await expect(mock.complete(aborted)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "transport",
      provider: "mock",
    });
    await expect(collect(mock.stream(aborted))).rejects.toMatchObject({
      kind: "transport",
    });
    // Aborted at entry → the call never resolved a response.
    expect(mock.calls).toEqual([]);
  });

  it("throws the raw abort reason mid-stream", async () => {
    const controller = new AbortController();
    const reason = new Error("mid");
    const mock = new MockProvider({ response: "a b c" });
    const iterator = mock
      .stream({ ...PROMPT, signal: controller.signal })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toBe("a ");
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
  });
});

describe("MockProvider — recording, reset, embeddings", () => {
  it("records requests and reset() clears calls + rewinds the cursor", async () => {
    const mock = new MockProvider({ response: ["a", "b"] });
    await mock.complete(PROMPT);
    expect(mock.calls).toEqual([PROMPT]);

    mock.reset();
    expect(mock.calls).toEqual([]);
    expect(await completeText(mock)).toBe("a");
  });

  it("exposes embed only when configured", async () => {
    expect(new MockProvider().embed).toBeUndefined();

    const mock = new MockProvider({
      embed: () => ({ embeddings: [[1, 2, 3]], model: "e" }),
    });
    expect(typeof mock.embed).toBe("function");
    const result = await mock.embed!({ input: ["hi"] });
    expect(result.embeddings).toEqual([[1, 2, 3]]);
  });
});

describe("MockProvider — through the registry and combine", () => {
  it("selects a BYO MockProvider and reports the unsupported-embed throw", async () => {
    const registry = new ProviderRegistry({
      custom: {
        mock: {
          kind: "provider",
          provider: new MockProvider({ response: "hi" }),
        },
      },
    });
    const provider = registry.select("mock");
    expect(await completeText(provider as MockProvider)).toBe("hi");
    await expect(registry.embed("mock", "hi")).rejects.toThrow(
      /does not support embeddings/,
    );
  });

  it("embeds through the registry when configured", async () => {
    const registry = new ProviderRegistry({
      custom: {
        mock: {
          kind: "provider",
          provider: new MockProvider({
            embed: () => ({ embeddings: [[1]], model: "e" }),
          }),
        },
      },
    });
    const { embedding } = await registry.embed("mock", "hi");
    expect(embedding).toEqual([1]);
  });

  it("drives broadcast and consensus network-free with two mocks", async () => {
    const registry = new ProviderRegistry({
      custom: {
        a: {
          kind: "provider",
          provider: new MockProvider({ name: "a", response: "answer-a" }),
        },
        b: {
          kind: "provider",
          provider: new MockProvider({ name: "b", response: "answer-b" }),
        },
      },
    });

    const broadcast = await registry.broadcast({
      ...PROMPT,
      participants: ["a", "b"],
    });
    expect(broadcast.strategy).toBe("broadcast");
    expect(broadcast.responses).toHaveLength(2);
    expect(broadcast.responses.every((r) => r.status === "ok")).toBe(true);

    const consensus = await registry.consensus({
      ...PROMPT,
      participants: ["a", "b"],
    });
    expect(consensus.strategy).toBe("consensus");
    expect(consensus.text.length).toBeGreaterThan(0);
  });
});
