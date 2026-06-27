// Parse an OpenAI-style Server-Sent Events stream into JSON chunk objects.
// Handles chunk boundaries that split a line across two reads, stops at [DONE],
// and tolerates malformed `data:` payloads by skipping them rather than throwing.
export async function* parseSSE<T = any>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // skip comments, event:, blank lines
        const data = line.slice(5).trim();
        if (data === "") continue;
        if (data === "[DONE]") return;
        let parsed: T;
        try {
          parsed = JSON.parse(data) as T;
        } catch {
          continue; // tolerate a malformed frame; keep streaming
        }
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
