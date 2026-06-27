// Error hierarchy for the ONE SDK.
//
// `OneError` is the root of every error this SDK throws. HTTP failures map to an
// `APIError` subclass keyed off the response status; transport failures (DNS,
// connection reset, fetch throwing) surface as `APIConnectionError`, and aborts
// triggered by the per-request timeout surface as `APITimeoutError`.

/** Loosely-typed JSON body returned by the gateway on an error response. */
export type ErrorBody =
  | string
  | {
      error?: { message?: string; type?: string; code?: string | null; param?: string | null };
      message?: string;
      [k: string]: unknown;
    }
  | null
  | undefined;

/** Minimal header accessor — works for `Headers`, plain objects, and `undefined`. */
export type HeaderLike = Headers | Record<string, string> | undefined;

function getHeader(headers: HeaderLike, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const rec = headers as Record<string, string>;
  // Case-insensitive lookup over a plain object.
  const hit = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? rec[hit] : null;
}

/** Pull a human-readable message out of an arbitrary error body. */
function extractMessage(body: ErrorBody): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body.length ? body : undefined;
  if (typeof body.error === "object" && body.error && typeof body.error.message === "string") {
    return body.error.message;
  }
  if (typeof body.message === "string") return body.message;
  return undefined;
}

function extractCode(body: ErrorBody): string | undefined {
  if (body == null || typeof body === "string") return undefined;
  const code = body.error?.code;
  return typeof code === "string" ? code : undefined;
}

function extractType(body: ErrorBody): string | undefined {
  if (body == null || typeof body === "string") return undefined;
  const type = body.error?.type;
  return typeof type === "string" ? type : undefined;
}

/** Root error type. Everything the SDK throws is an instance of `OneError`. */
export class OneError extends Error {
  /** HTTP status when known; `0` for transport/abort/config errors. */
  readonly status: number;
  /** Provider error `code` when present in the body. */
  readonly code?: string;
  /** Provider error `type` when present in the body. */
  readonly type?: string;
  /** Raw error body, retained for debugging. */
  readonly body?: ErrorBody;

  constructor(
    message: string,
    opts: { status?: number; code?: string; type?: string; body?: ErrorBody; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OneError";
    this.status = opts.status ?? 0;
    this.code = opts.code;
    this.type = opts.type;
    this.body = opts.body;
    // Preserve prototype chain when compiled down to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for any error that originated from an HTTP response with a status. */
export class APIError extends OneError {
  declare readonly status: number;
  readonly headers?: HeaderLike;

  constructor(
    status: number,
    message: string,
    opts: { code?: string; type?: string; body?: ErrorBody; headers?: HeaderLike } = {},
  ) {
    super(message, { status, code: opts.code, type: opts.type, body: opts.body });
    this.name = "APIError";
    this.headers = opts.headers;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends APIError {
  constructor(status: number, message: string, opts?: ConstructorParameters<typeof APIError>[2]) {
    super(status, message, opts);
    this.name = "BadRequestError";
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

export class AuthenticationError extends APIError {
  constructor(message: string, opts?: ConstructorParameters<typeof APIError>[2]) {
    super(401, message, opts);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

export class PermissionDeniedError extends APIError {
  constructor(message: string, opts?: ConstructorParameters<typeof APIError>[2]) {
    super(403, message, opts);
    this.name = "PermissionDeniedError";
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
  }
}

export class NotFoundError extends APIError {
  constructor(message: string, opts?: ConstructorParameters<typeof APIError>[2]) {
    super(404, message, opts);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class RateLimitError extends APIError {
  /** Parsed `retry-after` header in seconds, when the server sent one. */
  readonly retryAfter?: number;

  constructor(message: string, opts?: ConstructorParameters<typeof APIError>[2]) {
    super(429, message, opts);
    this.name = "RateLimitError";
    this.retryAfter = parseRetryAfter(opts?.headers);
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class InternalServerError extends APIError {
  constructor(status: number, message: string, opts?: ConstructorParameters<typeof APIError>[2]) {
    super(status, message, opts);
    this.name = "InternalServerError";
    Object.setPrototypeOf(this, InternalServerError.prototype);
  }
}

/** Thrown when the request never reached the gateway (DNS, reset, fetch threw). */
export class APIConnectionError extends OneError {
  constructor(message = "Connection error.", cause?: unknown) {
    super(message, { status: 0, cause });
    this.name = "APIConnectionError";
    Object.setPrototypeOf(this, APIConnectionError.prototype);
  }
}

/** Thrown when a request exceeds the configured timeout and is aborted. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out.", cause?: unknown) {
    super(message, cause);
    this.name = "APITimeoutError";
    Object.setPrototypeOf(this, APITimeoutError.prototype);
  }
}

/**
 * Parse a `retry-after` header into seconds. The header may be either a number
 * of seconds (`"30"`) or an HTTP date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns `undefined` when absent or unparseable.
 */
export function parseRetryAfter(headers: HeaderLike): number | undefined {
  const raw = getHeader(headers, "retry-after");
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  // Plain seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) ? secs : undefined;
  }
  // HTTP date → delta from now.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const delta = (when - Date.now()) / 1000;
  return delta > 0 ? delta : 0;
}

/**
 * Build the right `APIError` subclass for an HTTP status + body. Used by the
 * client after a non-2xx response. `body` may be a parsed object or raw string.
 */
export function fromResponse(status: number, body: ErrorBody, headers?: HeaderLike): APIError {
  const message = errorMessage(status, body);
  const opts = { code: extractCode(body), type: extractType(body), body, headers };

  if (status === 401) return new AuthenticationError(message, opts);
  if (status === 403) return new PermissionDeniedError(message, opts);
  if (status === 404) return new NotFoundError(message, opts);
  if (status === 429) return new RateLimitError(message, opts);
  if (status === 400 || status === 422) return new BadRequestError(status, message, opts);
  if (status >= 500) return new InternalServerError(status, message, opts);
  // Any other 4xx falls back to a generic APIError.
  return new APIError(status, message, opts);
}

/** Format a stable, readable error message from status + body. */
function errorMessage(status: number, body: ErrorBody): string {
  const detail = extractMessage(body);
  const label = STATUS_LABELS[status] ?? "API error";
  return detail ? `${status} ${label}: ${detail}` : `${status} ${label}`;
}

const STATUS_LABELS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
