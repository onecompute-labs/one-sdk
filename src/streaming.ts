// Async-iterable wrapper around the SSE parser.
//
// `Stream<T>` turns a Server-Sent Events `ReadableStream` into a one-shot async
// iterable of decoded chunks. It owns an `AbortController` so callers can cancel
// an in-flight stream with `stream.controller.abort()`, and it tears the
// request down on completion, error, or early `break`.

import { parseSSE } from "./sse.js";

export class Stream<T> implements AsyncIterable<T> {
  /** Aborts the request feeding this stream. Wired by the client to the fetch. */
  readonly controller: AbortController;

  #iterator: AsyncGenerator<T>;
  #consumed = false;

  constructor(source: ReadableStream<Uint8Array> | AsyncGenerator<T>, controller?: AbortController) {
    this.controller = controller ?? new AbortController();
    this.#iterator = isReadableStream(source) ? parseSSE<T>(source) : source;
  }

  /**
   * Build a `Stream` directly from an iterable of already-decoded chunks.
   * Handy for tests and for replaying buffered events.
   */
  static fromChunks<T>(chunks: Iterable<T> | AsyncIterable<T>): Stream<T> {
    async function* gen(): AsyncGenerator<T> {
      for await (const c of chunks as AsyncIterable<T>) yield c;
    }
    return new Stream<T>(gen());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#consumed) {
      throw new Error("Stream has already been consumed; iterate it only once.");
    }
    this.#consumed = true;
    try {
      for await (const chunk of this.#iterator) {
        yield chunk;
      }
    } finally {
      // If the caller breaks early, tear down both the generator and the request.
      try {
        await this.#iterator.return?.(undefined as never);
      } catch {
        // ignore teardown errors
      }
      this.controller.abort();
    }
  }

  /** Drain the entire stream into an array. Convenience for non-incremental use. */
  async collect(): Promise<T[]> {
    const out: T[] = [];
    for await (const chunk of this) out.push(chunk);
    return out;
  }

  /** Cancel the stream and abort the backing request. */
  abort(): void {
    this.controller.abort();
  }
}

function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof (x as ReadableStream)?.getReader === "function";
}
