import { describe, expect, it } from "@jest/globals";

import { cosineSimilarity } from "../embeddings";

describe("cosineSimilarity", () => {
  it("is 1 for identical (parallel) vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    // Scale-invariant: same direction, different magnitude → still 1.
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it("returns 0 (not NaN) when either vector is all zeros", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("throws on a length mismatch", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(
      "equal-length vectors",
    );
  });
});
