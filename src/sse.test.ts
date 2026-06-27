import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSE } from "./sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

test("parses chunks split mid-line and stops at [DONE]", async () => {
  const s = streamOf([
    'data: {"i":1}\n',
    'data: {"i"', ':2}\n', // one JSON object split across two reads
    "data: [DONE]\n",
    'data: {"i":3}\n', // anything after [DONE] is ignored
  ]);
  const out: number[] = [];
  for await (const c of parseSSE<{ i: number }>(s)) out.push(c.i);
  assert.deepEqual(out, [1, 2]);
});

test("ignores non-data lines (comments, blanks)", async () => {
  const s = streamOf([": keep-alive\n", "\n", 'data: {"ok":true}\n']);
  const out: any[] = [];
  for await (const c of parseSSE(s)) out.push(c);
  assert.deepEqual(out, [{ ok: true }]);
});

test("parses many events delivered in a single read", async () => {
  const s = streamOf(['data: {"i":1}\ndata: {"i":2}\ndata: {"i":3}\ndata: [DONE]\n']);
  const out: number[] = [];
  for await (const c of parseSSE<{ i: number }>(s)) out.push(c.i);
  assert.deepEqual(out, [1, 2, 3]);
});

test("skips a malformed data frame and continues", async () => {
  const s = streamOf(['data: {"i":1}\n', "data: {oops}\n", 'data: {"i":2}\n', "data: [DONE]\n"]);
  const out: number[] = [];
  for await (const c of parseSSE<{ i: number }>(s)) out.push(c.i);
  assert.deepEqual(out, [1, 2]);
});

test("handles a stream that ends without an explicit [DONE]", async () => {
  const s = streamOf(['data: {"i":1}\n', 'data: {"i":2}\n']);
  const out: number[] = [];
  for await (const c of parseSSE<{ i: number }>(s)) out.push(c.i);
  assert.deepEqual(out, [1, 2]);
});

test("breaking out of the loop releases the reader (no throw)", async () => {
  const s = streamOf(['data: {"i":1}\n', 'data: {"i":2}\n', 'data: {"i":3}\n']);
  const out: number[] = [];
  for await (const c of parseSSE<{ i: number }>(s)) {
    out.push(c.i);
    if (c.i === 1) break; // early abort of iteration
  }
  assert.deepEqual(out, [1]);
});
