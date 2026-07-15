import { describe, expect, it } from "@jest/globals";

import { ProviderError } from "../../errors";
import { sseJson } from "../sse";

const encoder = new TextEncoder();

/** A stream that yields the given chunks, then rejects the next read with `error`. */
function streamThenReject(
  chunks: string[],
  error: unknown,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      controller.error(error);
    },
  });
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of sseJson(stream, "openai")) {
    events.push(event);
  }
  return events;
}

describe("sseJson", () => {
  it("yields each data line's parsed JSON object", async () => {
    const events = await collect(
      streamOf(['data: {"a":1}\n', 'data: {"b":2}\n', "data: [DONE]\n"]),
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("wraps an abort during the read as a transport ProviderError", async () => {
    const abort = new DOMException("The operation timed out.", "TimeoutError");
    const stream = streamThenReject(['data: {"a":1}\n'], abort);

    const events: Array<Record<string, unknown>> = [];
    let error: unknown;
    try {
      for await (const event of sseJson(stream, "openai")) {
        events.push(event);
      }
    } catch (e: unknown) {
      error = e;
    }

    expect(events).toEqual([{ a: 1 }]); // the pre-abort event still arrived
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("transport");
    expect((error as ProviderError).cause).toBe(abort);
  });
});
