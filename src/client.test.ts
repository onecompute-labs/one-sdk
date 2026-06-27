import { test } from "node:test";
import assert from "node:assert/strict";
import { OneClient, DEFAULT_BASE_URL } from "./client.js";
import {
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  BadRequestError,
  RateLimitError,
  InternalServerError,
  APITimeoutError,
} from "./errors.js";
import { Stream } from "./streaming.js";
import type { ChatCompletion, ChatCompletionChunk } from "./types.js";

/* --------------------------------------------------------- mock helpers */

interface MockCall {
  url: string;
  init: RequestInit;
}

/** Build a JSON `Response`. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Build an SSE `Response` from already-serialized event payloads. */
function sseResponse(events: object[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Create a mock `fetch` that returns each queued response in turn and records
 * every call. The last queued response repeats if calls exceed the queue.
 */
function mockFetch(responses: Array<Response | (() => Response)>) {
  const calls: MockCall[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const idx = Math.min(calls.length - 1, responses.length - 1);
    const r = responses[idx];
    return typeof r === "function" ? r() : r;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const CHAT_BODY: ChatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "claude-haiku-4-5-20251001",
  choices: [
    { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new OneClient({ apiKey: "sk-test", fetch: fetchImpl, maxRetries: 2, ...extra });
}

/* --------------------------------------------------------- construction */

test("constructor throws without an apiKey", () => {
  assert.throws(() => new OneClient({ apiKey: "" } as never), /apiKey is required/);
});

test("default baseURL is the public gateway", () => {
  const { fetch } = mockFetch([jsonResponse(200, CHAT_BODY)]);
  const c = client(fetch);
  assert.equal(c.baseURL, DEFAULT_BASE_URL);
});

test("baseURL trailing slashes are normalized", () => {
  const { fetch } = mockFetch([jsonResponse(200, CHAT_BODY)]);
  const c = client(fetch, { baseURL: "https://gw.example.com/v1///" });
  assert.equal(c.baseURL, "https://gw.example.com/v1");
});

/* ----------------------------------------------------------------- auth */

test("requests carry a bearer authorization header", async () => {
  const { fetch, calls } = mockFetch([jsonResponse(200, CHAT_BODY)]);
  const c = client(fetch);
  await c.chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test");
  assert.equal(headers["content-type"], "application/json");
});

test("defaultHeaders are merged into requests", async () => {
  const { fetch, calls } = mockFetch([jsonResponse(200, CHAT_BODY)]);
  const c = client(fetch, { defaultHeaders: { "x-trace": "abc" } });
  await c.models.list();
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-trace"], "abc");
});

/* --------------------------------------------------- chat (non-stream) */

test("non-stream chat completion parses the body", async () => {
  const { fetch, calls } = mockFetch([jsonResponse(200, CHAT_BODY)]);
  const c = client(fetch);
  const res = await c.chat.completions.create({
    model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.choices[0].message.content, "hi there");
  assert.equal(res.usage?.total_tokens, 5);
  // It hits the right path and sends stream:false.
  assert.match(calls[0].url, /\/chat\/completions$/);
  const sent = JSON.parse(calls[0].init.body as string);
  assert.equal(sent.stream, false);
});

/* ------------------------------------------------------- chat (stream) */

test("stream:true returns an async-iterable Stream of chunks", async () => {
  const chunk = (content: string): ChatCompletionChunk => ({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  const { fetch } = mockFetch([sseResponse([chunk("Hel"), chunk("lo")])]);
  const c = client(fetch);
  const stream = await c.chat.completions.create({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  assert.ok(stream instanceof Stream);
  let text = "";
  for await (const ch of stream) text += ch.choices[0].delta.content ?? "";
  assert.equal(text, "Hello");
});

test("streaming sends stream:true in the request body", async () => {
  const { fetch, calls } = mockFetch([sseResponse([])]);
  const c = client(fetch);
  const stream = await c.chat.completions.create({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  await stream.collect();
  const sent = JSON.parse(calls[0].init.body as string);
  assert.equal(sent.stream, true);
});

/* ----------------------------------------------------- error mapping */

test("401 throws AuthenticationError", async () => {
  const { fetch } = mockFetch([jsonResponse(401, { error: { message: "no key" } })]);
  const c = client(fetch);
  await assert.rejects(
    () => c.chat.completions.create({ model: "m", messages: [] }),
    (e: unknown) => e instanceof AuthenticationError && e.status === 401,
  );
});

test("403 throws PermissionDeniedError", async () => {
  const { fetch } = mockFetch([jsonResponse(403, {})]);
  const c = client(fetch);
  await assert.rejects(() => c.models.list(), PermissionDeniedError);
});

test("404 throws NotFoundError", async () => {
  const { fetch } = mockFetch([jsonResponse(404, {})]);
  const c = client(fetch);
  await assert.rejects(() => c.models.retrieve("nope"), NotFoundError);
});

test("400 throws BadRequestError and is NOT retried", async () => {
  const { fetch, calls } = mockFetch([jsonResponse(400, { error: { message: "bad" } })]);
  const c = client(fetch, { maxRetries: 3 });
  await assert.rejects(() => c.chat.completions.create({ model: "m", messages: [] }), BadRequestError);
  assert.equal(calls.length, 1, "4xx must not be retried");
});

test("500 throws InternalServerError after exhausting retries", async () => {
  const { fetch } = mockFetch([jsonResponse(500, {})]);
  const c = client(fetch, { maxRetries: 0 });
  await assert.rejects(() => c.models.list(), InternalServerError);
});

/* --------------------------------------------------------------- retry */

test("retries on 429 then succeeds", async () => {
  const { fetch, calls } = mockFetch([
    jsonResponse(429, { error: { message: "slow" } }, { "retry-after": "0" }),
    jsonResponse(200, CHAT_BODY),
  ]);
  const c = client(fetch, { maxRetries: 2 });
  const res = await c.chat.completions.create({ model: "m", messages: [] });
  assert.equal(res.choices[0].message.content, "hi there");
  assert.equal(calls.length, 2, "one retry after the 429");
});

test("retries on 503 then succeeds", async () => {
  const { fetch, calls } = mockFetch([
    jsonResponse(503, {}),
    jsonResponse(200, CHAT_BODY),
  ]);
  const c = client(fetch, { maxRetries: 2 });
  await c.chat.completions.create({ model: "m", messages: [] });
  assert.equal(calls.length, 2);
});

test("gives up after maxRetries and throws the mapped error", async () => {
  const { fetch, calls } = mockFetch([jsonResponse(429, {}, { "retry-after": "0" })]);
  const c = client(fetch, { maxRetries: 2 });
  await assert.rejects(() => c.models.list(), RateLimitError);
  // initial attempt + 2 retries = 3 calls
  assert.equal(calls.length, 3);
});

test("connection errors are retried then surfaced", async () => {
  let n = 0;
  const fn = (async () => {
    n++;
    if (n < 3) throw new TypeError("network down");
    return jsonResponse(200, CHAT_BODY);
  }) as unknown as typeof fetch;
  const c = client(fn, { maxRetries: 2 });
  const res = await c.chat.completions.create({ model: "m", messages: [] });
  assert.equal(res.choices[0].message.content, "hi there");
  assert.equal(n, 3);
});

/* ------------------------------------------------------------- timeout */

test("timeout aborts the request and throws APITimeoutError", async () => {
  // A fetch that never resolves until its signal aborts, then rejects like the platform does.
  const fn = ((_url: RequestInfo | URL, init: RequestInit = {}) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }
    });
  }) as unknown as typeof fetch;
  const c = client(fn, { timeout: 20, maxRetries: 0 });
  await assert.rejects(
    () => c.chat.completions.create({ model: "m", messages: [] }),
    APITimeoutError,
  );
});

/* --------------------------------------------------- other resources */

test("embeddings.create posts to /embeddings and parses data", async () => {
  const body = {
    object: "list",
    model: "text-embedding-3-small",
    data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
    usage: { prompt_tokens: 4, total_tokens: 4 },
  };
  const { fetch, calls } = mockFetch([jsonResponse(200, body)]);
  const c = client(fetch);
  const res = await c.embeddings.create({ model: "text-embedding-3-small", input: "hello" });
  assert.match(calls[0].url, /\/embeddings$/);
  assert.deepEqual(res.data[0].embedding, [0.1, 0.2, 0.3]);
});

test("images.generate posts to /images/generations", async () => {
  const body = { created: 1, data: [{ url: "https://img.example/1.png" }] };
  const { fetch, calls } = mockFetch([jsonResponse(200, body)]);
  const c = client(fetch);
  const res = await c.images.generate({ prompt: "a cat", size: "1024x1024" });
  assert.match(calls[0].url, /\/images\/generations$/);
  assert.equal(res.data[0].url, "https://img.example/1.png");
});

test("models.list and models.retrieve hit the right paths", async () => {
  const list = { object: "list", data: [{ id: "m1", object: "model", created: 1, owned_by: "one" }] };
  const one = { id: "m1", object: "model", created: 1, owned_by: "one" };
  const { fetch, calls } = mockFetch([jsonResponse(200, list), jsonResponse(200, one)]);
  const c = client(fetch);
  const all = await c.models.list();
  assert.equal(all.data[0].id, "m1");
  const single = await c.models.retrieve("m1");
  assert.equal(single.id, "m1");
  assert.match(calls[0].url, /\/models$/);
  assert.match(calls[1].url, /\/models\/m1$/);
  assert.equal(calls[0].init.method, "GET");
});

/* -------------------------------------------------------------- receipt */

test("a receipt header is extracted onto the response as _receipt", async () => {
  const receipt = {
    prev: "0xprev",
    requestHash: "0xreq",
    model: "m",
    worker: "worker-7",
    outputDigest: "0xout",
    sig: "0xsig",
  };
  const { fetch } = mockFetch([
    jsonResponse(200, CHAT_BODY, { "x-one-receipt": JSON.stringify(receipt) }),
  ]);
  const c = client(fetch);
  const res = await c.chat.completions.create({ model: "m", messages: [] });
  assert.deepEqual(res._receipt, receipt);
  // The receipt is non-enumerable, so it stays out of the serialized body.
  assert.ok(!Object.keys(res).includes("_receipt"));
});

test("a malformed receipt header is ignored, not fatal", async () => {
  const { fetch } = mockFetch([jsonResponse(200, CHAT_BODY, { "x-one-receipt": "{not json" })]);
  const c = client(fetch);
  const res = await c.chat.completions.create({ model: "m", messages: [] });
  assert.equal(res._receipt, undefined);
  assert.equal(res.choices[0].message.content, "hi there");
});
