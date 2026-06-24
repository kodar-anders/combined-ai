import { describe, expect, it } from "@jest/globals";

import {
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
  type Usage,
} from "../../types";
import {
  compareAnswers,
  fieldSemanticAgreement,
  type ResolvedEmbedder,
} from "../embedding";

// Fixed 2-D vectors so the cosine relationships are obvious:
// a and b are identical (cosine 1); c is orthogonal to both (cosine 0).
const VECTORS: Record<string, number[]> = {
  "answer a": [1, 0],
  "answer b": [1, 0],
  "answer c": [0, 1],
};

function fakeEmbedder(usage?: Usage, calls?: string[][]): ResolvedEmbedder {
  const provider: Provider & { embed: NonNullable<Provider["embed"]> } = {
    name: "emb",
    complete: () => {
      throw new Error("complete not used in this test");
    },
    stream: () => {
      throw new Error("stream not used in this test");
    },
    embed: (request: EmbeddingRequest): Promise<EmbeddingResult> => {
      calls?.push(request.input);
      return Promise.resolve({
        embeddings: request.input.map((text) => VECTORS[text] ?? [0, 0]),
        model: "embed-model",
        usage,
      });
    },
  };
  return { name: "emb", provider };
}

function answers(...texts: string[]): Array<{ id: string; text: string }> {
  // Give each answer an id matching its position so assertions are readable.
  const ids = ["p1", "p2", "p3"];
  return texts.map((text, i) => ({ id: ids[i] ?? `p${String(i + 1)}`, text }));
}

describe("compareAnswers", () => {
  it("returns undefined when there are fewer than two answers", async () => {
    expect(
      await compareAnswers(fakeEmbedder(), answers("answer a")),
    ).toBeUndefined();
    expect(await compareAnswers(fakeEmbedder(), answers())).toBeUndefined();
  });

  it("scores agreement, the outlier, and clusters across three answers", async () => {
    const result = await compareAnswers(
      fakeEmbedder({ inputTokens: 6, outputTokens: 0, totalTokens: 6 }),
      answers("answer a", "answer b", "answer c"),
    );

    expect(result).toBeDefined();
    // Mean pairwise cosine over (a,b)=1, (a,c)=0, (b,c)=0 → 1/3.
    expect(result?.comparison.agreement).toBeCloseTo(1 / 3);
    // c is farthest from the centroid (it's orthogonal to the a/b pair).
    expect(result?.comparison.outlier).toBe("p3");
    // a and b cluster; c stands alone.
    expect(result?.comparison.clusters).toEqual([["p1", "p2"], ["p3"]]);
    // The billed embedding call is tagged `embedding:<provider>` so it can't
    // collide with a participant id that defaults to the provider name.
    expect(result?.usage).toEqual({
      id: "embedding:emb",
      model: "embed-model",
      usage: { inputTokens: 6, outputTokens: 0, totalTokens: 6 },
    });
  });

  it("reports no outlier with exactly two answers (both equidistant)", async () => {
    const result = await compareAnswers(
      fakeEmbedder(),
      answers("answer a", "answer c"),
    );

    expect(result?.comparison.agreement).toBeCloseTo(0);
    expect(result?.comparison.outlier).toBeUndefined();
    expect(result?.comparison.clusters).toEqual([["p1"], ["p2"]]);
  });

  it("carries through an embedder that reports no usage", async () => {
    const result = await compareAnswers(
      fakeEmbedder(),
      answers("answer a", "answer b"),
    );

    expect(result?.comparison.agreement).toBeCloseTo(1);
    expect(result?.usage).toEqual({
      id: "embedding:emb",
      model: "embed-model",
    });
  });
});

describe("fieldSemanticAgreement", () => {
  it("scores each field and embeds all values in one batched call", async () => {
    const calls: string[][] = [];
    const result = await fieldSemanticAgreement(
      fakeEmbedder(undefined, calls),
      [
        { key: "x", values: ["answer a", "answer b"] }, // identical → 1
        { key: "y", values: ["answer a", "answer c"] }, // orthogonal → 0
      ],
    );

    expect(result?.agreement.x).toBeCloseTo(1);
    expect(result?.agreement.y).toBeCloseTo(0);
    // A single embed call carrying every field's values, in order.
    expect(calls).toEqual([["answer a", "answer b", "answer a", "answer c"]]);
  });

  it("skips fields with fewer than two values", async () => {
    const result = await fieldSemanticAgreement(fakeEmbedder(), [
      { key: "x", values: ["answer a", "answer b"] },
      { key: "lonely", values: ["answer c"] },
    ]);

    expect(result?.agreement).toEqual({ x: expect.closeTo(1) });
    expect(result?.agreement.lonely).toBeUndefined();
  });

  it("returns undefined when no field has two or more values", async () => {
    const result = await fieldSemanticAgreement(fakeEmbedder(), [
      { key: "x", values: ["answer a"] },
    ]);

    expect(result).toBeUndefined();
  });

  it("declines when the provider returns a mismatched vector count", async () => {
    // A provider that violates the 1:1 contract (one vector for many inputs):
    // alignment can't be trusted, so both helpers decline rather than guess.
    const ragged: ResolvedEmbedder = {
      name: "emb",
      provider: {
        name: "emb",
        complete: () => {
          throw new Error("complete not used in this test");
        },
        stream: () => {
          throw new Error("stream not used in this test");
        },
        embed: (): Promise<EmbeddingResult> =>
          Promise.resolve({ embeddings: [[1, 0]], model: "embed-model" }),
      },
    };

    expect(
      await compareAnswers(ragged, answers("answer a", "answer b")),
    ).toBeUndefined();
    expect(
      await fieldSemanticAgreement(ragged, [
        { key: "x", values: ["answer a", "answer b"] },
      ]),
    ).toBeUndefined();
  });

  it("attributes the embedding call's usage to the embedder", async () => {
    const result = await fieldSemanticAgreement(
      fakeEmbedder({ inputTokens: 4, outputTokens: 0, totalTokens: 4 }),
      [{ key: "x", values: ["answer a", "answer b"] }],
    );

    expect(result?.usage).toEqual({
      id: "embedding:emb",
      model: "embed-model",
      usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
    });
  });
});
