import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromResponse,
  parseRetryAfter,
  OneError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  BadRequestError,
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APITimeoutError,
} from "./errors.js";

test("fromResponse maps 401 to AuthenticationError", () => {
  const e = fromResponse(401, { error: { message: "bad key" } });
  assert.ok(e instanceof AuthenticationError);
  assert.equal(e.status, 401);
  assert.match(e.message, /bad key/);
});

test("fromResponse maps 403 to PermissionDeniedError", () => {
  const e = fromResponse(403, "forbidden");
  assert.ok(e instanceof PermissionDeniedError);
  assert.equal(e.status, 403);
});

test("fromResponse maps 404 to NotFoundError", () => {
  const e = fromResponse(404, null);
  assert.ok(e instanceof NotFoundError);
  assert.equal(e.status, 404);
});

test("fromResponse maps 400 and 422 to BadRequestError", () => {
  assert.ok(fromResponse(400, {}) instanceof BadRequestError);
  const e = fromResponse(422, { error: { message: "invalid", code: "schema" } });
  assert.ok(e instanceof BadRequestError);
  assert.equal(e.status, 422);
  assert.equal(e.code, "schema");
});

test("fromResponse maps 429 to RateLimitError", () => {
  const e = fromResponse(429, { error: { message: "slow down" } });
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.status, 429);
});

test("fromResponse maps 500/502/503 to InternalServerError", () => {
  for (const s of [500, 502, 503, 504]) {
    const e = fromResponse(s, {});
    assert.ok(e instanceof InternalServerError, `status ${s}`);
    assert.equal(e.status, s);
  }
});

test("fromResponse falls back to generic APIError for other 4xx", () => {
  const e = fromResponse(409, { error: { message: "conflict" } });
  assert.ok(e instanceof APIError);
  assert.ok(!(e instanceof BadRequestError));
  assert.equal(e.status, 409);
});

test("every API error is also an OneError and an Error", () => {
  const e = fromResponse(401, "x");
  assert.ok(e instanceof OneError);
  assert.ok(e instanceof Error);
  assert.ok(e instanceof APIError);
});

test("error message formatting includes status, label, and detail", () => {
  const e = fromResponse(429, { error: { message: "quota exceeded" } });
  assert.equal(e.message, "429 Too Many Requests: quota exceeded");
});

test("error message formatting omits detail when body has none", () => {
  const e = fromResponse(500, {});
  assert.equal(e.message, "500 Internal Server Error");
});

test("error message reads top-level `message` field", () => {
  const e = fromResponse(400, { message: "top-level msg" });
  assert.match(e.message, /top-level msg/);
});

test("RateLimitError parses numeric retry-after header", () => {
  const e = fromResponse(429, {}, { "retry-after": "30" }) as RateLimitError;
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfter, 30);
});

test("RateLimitError retryAfter is undefined when header absent", () => {
  const e = fromResponse(429, {}) as RateLimitError;
  assert.equal(e.retryAfter, undefined);
});

test("parseRetryAfter handles numeric seconds", () => {
  assert.equal(parseRetryAfter({ "retry-after": "12" }), 12);
});

test("parseRetryAfter handles a Headers instance", () => {
  const h = new Headers({ "retry-after": "5" });
  assert.equal(parseRetryAfter(h), 5);
});

test("parseRetryAfter handles an HTTP-date in the future", () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const secs = parseRetryAfter({ "retry-after": future });
  assert.ok(secs !== undefined && secs > 5 && secs <= 11, `got ${secs}`);
});

test("parseRetryAfter returns undefined for missing or garbage", () => {
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter({}), undefined);
  assert.equal(parseRetryAfter({ "retry-after": "not-a-date" }), undefined);
});

test("parseRetryAfter is case-insensitive over plain objects", () => {
  assert.equal(parseRetryAfter({ "Retry-After": "7" }), 7);
});

test("APIConnectionError and APITimeoutError carry status 0", () => {
  const c = new APIConnectionError();
  const t = new APITimeoutError();
  assert.ok(c instanceof OneError);
  assert.ok(t instanceof APIConnectionError);
  assert.equal(c.status, 0);
  assert.equal(t.status, 0);
  assert.equal(t.name, "APITimeoutError");
});

test("OneError preserves the cause chain", () => {
  const root = new Error("root");
  const e = new APIConnectionError("wrap", root);
  assert.equal(e.cause, root);
});
