/**
 * Server-Sent Events parsing shared by the providers' streaming paths.
 */

import { isRecord } from "./extract";

/** Returned by {@link classifyLine} for the end-of-stream sentinel some providers send. */
const DONE = Symbol("sse-done");

/**
 * Read an SSE response body and yield each `data:` line's parsed JSON object, in
 * order. Blank lines, non-`data:` lines, and any payload that isn't a JSON object
 * are skipped; the `[DONE]` sentinel ends the stream (so a server that holds the
 * connection open past it doesn't hang the consumer). The reader is always
 * released — on normal completion, the `[DONE]` sentinel, an early `return` from
 * the consumer, or a throw.
 *
 * Each event these providers send is a single `data:` line, so multi-line `data:`
 * field concatenation (which the SSE spec allows) is intentionally not
 * implemented — none of the target APIs use it.
 */
export async function* sseJson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (
      let result = await reader.read();
      !result.done;
      result = await reader.read()
    ) {
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      // The last segment is the line after the final newline — still incomplete,
      // so hold it for the next chunk.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = classifyLine(line);
        if (event === DONE) {
          return;
        }
        if (event !== undefined) {
          yield event;
        }
      }
    }

    // Flush a final line the stream may have left without a trailing newline.
    const event = classifyLine(buffer);
    if (event !== undefined && event !== DONE) {
      yield event;
    }
  } finally {
    await reader.cancel();
  }
}

/**
 * Classify one SSE line: the parsed JSON object of its `data:` payload, the
 * {@link DONE} sentinel, or `undefined` to skip (blank/non-`data:`/non-JSON-object).
 */
function classifyLine(
  rawLine: string,
): Record<string, unknown> | typeof DONE | undefined {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) {
    return undefined;
  }
  const payload = line.slice("data:".length).trim();
  if (payload === "") {
    return undefined;
  }
  if (payload === "[DONE]") {
    return DONE;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
