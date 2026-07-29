/**
 * Typed provider errors. Every provider throws a {@link ProviderError} so
 * consumers can branch on `err.status` / `err.kind` / `err.code` instead of
 * regex-matching a message string.
 */

import { type ProviderName } from "./registry";

/**
 * Whether the failure happened after the provider responded (`"api"` — an
 * HTTP error status, so `status` is set) or before any response arrived
 * (`"transport"` — a network/DNS failure or an aborted request, so `status` is
 * undefined). Branch on this to tell "the provider said no" from "we never
 * reached the provider".
 */
export type ProviderErrorKind = "api" | "transport";

type ProviderErrorInit = {
  provider: ProviderName;
  kind: ProviderErrorKind;
  status?: number;
  code?: string;
  type?: string;
  body?: string;
  cause?: unknown;
};

/** An error from a provider call, carrying enough structure to handle it programmatically. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  /** Which provider produced the failure. */
  readonly provider: ProviderName;
  /** Transport failure (no response) vs API failure (error response). */
  readonly kind: ProviderErrorKind;
  /** HTTP status for `kind: "api"`; `undefined` for transport failures. */
  readonly status?: number;
  /** Machine-readable code parsed from the error body, where the provider sends one. */
  readonly code?: string;
  /** Error category parsed from the body (Anthropic/OpenAI `type`, Gemini `status`). */
  readonly type?: string;
  /** The raw response body, for `kind: "api"`. */
  readonly body?: string;

  constructor(message: string, init: ProviderErrorInit) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.provider = init.provider;
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.body = init.body;
  }

  /**
   * Serialize to a plain object, so a bare `JSON.stringify(error)` round-trips the
   * fields a consumer actually needs — logging a {@link ParticipantOutcome}, shipping
   * it to a worker, persisting it for replay. Without this, `message` is lost (it's
   * non-enumerable on `Error`), while `structuredClone` keeps the message but
   * downgrades to a plain `Error`, dropping `status`/`kind`/`code`. `name` is included
   * so a deserialized object is still identifiable as a `ProviderError`.
   *
   * `body` is deliberately omitted — {@link apiError} already embeds it verbatim in
   * `message`, so carrying it here would just double a payload that is often large.
   * Read `error.body` off the live object when you want it on its own. `cause` is
   * omitted too: it can hold any value, including ones that don't serialize.
   *
   * Undefined fields are dropped by `JSON.stringify`, so a `transport` error
   * serializes to `{ name, message, provider, kind }`.
   */
  toJSON(): {
    name: string;
    message: string;
    provider: ProviderName;
    kind: ProviderErrorKind;
    status?: number;
    code?: string;
    type?: string;
  } {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      kind: this.kind,
      status: this.status,
      code: this.code,
      type: this.type,
    };
  }
}

/**
 * Build a `transport` {@link ProviderError} from a rejected request (a network/DNS
 * failure or an aborted signal). Derives the message from `cause` and carries it
 * through, so the caller always gets provider context. The single source of the
 * transport-error shape — both the `fetch` wrapper and the test `MockProvider`
 * throw through here.
 */
export function transportError(
  provider: ProviderName,
  cause: unknown,
): ProviderError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new ProviderError(`${provider} request failed: ${reason}`, {
    provider,
    kind: "transport",
    cause,
  });
}

/**
 * Build an `api` {@link ProviderError} from a non-2xx response, parsing the
 * provider's error body for a machine `code`/`type` where present.
 */
export async function apiError(
  provider: ProviderName,
  response: Response,
): Promise<ProviderError> {
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    // The error body is read after the headers, so an abort/timeout (or a dropped
    // connection) firing here escapes as a raw DOMException/TypeError unless wrapped
    // — which would break fallback's ProviderError-based advancement. `text()` never
    // parses, so every failure here is transport, not a body-format error.
    return transportError(provider, cause);
  }
  const { code, type } = parseErrorBody(body);
  return new ProviderError(
    `${provider} request failed (${String(response.status)}): ${body}`,
    { provider, kind: "api", status: response.status, code, type, body },
  );
}

/**
 * Build an `api` {@link ProviderError} from a 2xx response whose JSON body
 * nevertheless carries an `{ error }` payload (a provider or proxy returning
 * HTTP 200 with an error). Mirrors {@link apiError} but for an already-parsed
 * success-status body, so the call surfaces as a typed failure instead of a
 * silent empty result.
 */
export function apiErrorFromBody(
  provider: ProviderName,
  status: number,
  data: unknown,
): ProviderError {
  const body = JSON.stringify(data);
  const { code, type } = parseErrorFields(data);
  return new ProviderError(
    `${provider} request failed (${String(status)}): ${body}`,
    { provider, kind: "api", status, code, type, body },
  );
}

/**
 * Build the error for a batch operation that produced no usable result. When some
 * sub-operations actually failed, their errors are attached as an
 * {@link AggregateError} (`.errors`) so the caller can inspect each underlying
 * cause; when `causes` is empty (the batch yielded nothing usable but nothing
 * threw), a plain {@link Error} is returned. `message` is preserved on both, so
 * message-based assertions hold either way. Provider/feature-agnostic — the caller
 * supplies the causes it collected.
 */
export function aggregateError(message: string, causes: Error[]): Error {
  return causes.length > 0
    ? new AggregateError(causes, message)
    : new Error(message);
}

/**
 * Pull a machine `code`/`type` out of an error body across the three vendors'
 * shapes: all nest the detail under `error`; the human code is OpenAI's
 * `error.code` (a string — Gemini's `code` is the numeric HTTP status, so it's
 * skipped), and the category is `error.type` (Anthropic/OpenAI) or `error.status`
 * (Gemini).
 */
function parseErrorBody(body: string): { code?: string; type?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  return parseErrorFields(parsed);
}

/** Extract `code`/`type` from an already-parsed error body (see {@link parseErrorBody}). */
function parseErrorFields(parsed: unknown): { code?: string; type?: string } {
  if (!isRecord(parsed)) {
    return {};
  }
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  const code = typeof error.code === "string" ? error.code : undefined;
  const type =
    typeof error.type === "string"
      ? error.type
      : typeof error.status === "string"
        ? error.status
        : undefined;
  return { code, type };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
