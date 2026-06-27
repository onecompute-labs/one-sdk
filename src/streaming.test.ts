import { test } from "node:test";
import assert from "node:assert/strict";
import { Stream } from "./streaming.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

test("Stream yields multiple SSE events in order", async () => {
  const body = streamOf([
    'data: {"i":1}\n',
    'data: {"i":2}\n',
    'data: {"i":3}\n',
    "data: [DONE]\n",
  ]);
  const stream = new Stream<{ i: number }>(body);
  const out: number[] = [];
  for await (const c of stream) out.push(c.i);
  assert.deepEqual(out, [1, 2, 3]);
});

test("Stream.collect drains everything to an array", async () => {
  const body = streamOf(['data: {"i":1}\n', 'data: {"i":2}\n', "data: [DONE]\n"]);
  const stream = new Stream<{ i: number }>(body);
  const all = await stream.collect();
  assert.deepEqual(all, [{ i: 1 }, { i: 2 }]);
});

test("Stream tolerates malformed data frames and keeps going", async () => {
  const body = streamOf([
    'data: {"i":1}\n',
    "data: {not json}\n",
    'data: {"i":2}\n',
    "data: [DONE]\n",
  ]);
  const stream = new Stream<{ i: number }>(body);
  const out = (await stream.collect()).map((c) => c.i);
  assert.deepEqual(out, [1, 2]);
});

test("Stream cannot be iterated twice", async () => {
  const body = streamOf(['data: {"i":1}\n', "data: [DONE]\n"]);
  const stream = new Stream<{ i: number }>(body);
  await stream.collect();
  await assert.rejects(async () => {
    for await (const _ of stream) void _;
  }, /already been consumed/);
});

test("breaking early aborts the backing controller", async () => {
  const controller = new AbortController();
  const body = streamOf(['data: {"i":1}\n', 'data: {"i":2}\n', 'data: {"i":3}\n']);
  const stream = new Stream<{ i: number }>(body, controller);
  for await (const c of stream) {
    if (c.i === 1) break;
  }
  assert.ok(controller.signal.aborted, "controller should be aborted after early break");
});

test("abort() flips the controller signal", () => {
  const controller = new AbortController();
  const body = streamOf(["data: [DONE]\n"]);
  const stream = new Stream(body, controller);
  assert.equal(controller.signal.aborted, false);
  stream.abort();
  assert.equal(controller.signal.aborted, true);
});

test("Stream.fromChunks wraps a plain iterable", async () => {
  const stream = Stream.fromChunks([{ x: "a" }, { x: "b" }]);
  const out = await stream.collect();
  assert.deepEqual(out, [{ x: "a" }, { x: "b" }]);
});
