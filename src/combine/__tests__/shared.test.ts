import { describe, expect, it } from "@jest/globals";

import { type CombineRequest } from "../index";
import { completionFor } from "../shared";

const MESSAGES = [{ role: "user" as const, content: "hi" }];

function combineRequest(extra: Partial<CombineRequest>): CombineRequest {
  return {
    messages: MESSAGES,
    participants: ["a"],
    ...extra,
  };
}

describe("completionFor", () => {
  it("forwards retry and timeoutMs to each participant call", () => {
    const request = combineRequest({
      retry: { maxRetries: 3 },
      timeoutMs: 5000,
    });

    const completion = completionFor(request, undefined, MESSAGES);

    expect(completion.retry).toEqual({ maxRetries: 3 });
    expect(completion.timeoutMs).toBe(5000);
  });

  it("omits retry and timeoutMs when the request has neither", () => {
    const completion = completionFor(combineRequest({}), undefined, MESSAGES);

    expect(completion.retry).toBeUndefined();
    expect(completion.timeoutMs).toBeUndefined();
  });
});
