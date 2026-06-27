# @onecompute/sdk

[![npm version](https://img.shields.io/badge/npm-v0.1.0-cb3837)](https://www.npmjs.com/package/@onecompute/sdk)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)
[![types](https://img.shields.io/badge/types-included-3178c6)](https://www.typescriptlang.org)

OpenAI-compatible TypeScript SDK for **[ONE](https://onecomputeai.xyz)** — the token-gated, decentralized AI compute network.

> **Hold $ONE, AI is yours.**

ONE routes inference to a permissionless network of workers. Stake $ONE for the Included lane (free credits) or pay-as-you-go in USDT — either way you hit a single OpenAI-shaped gateway. The request and response schemas mirror OpenAI's, so this client is a **drop-in replacement**: change the base URL and your key, keep your existing code, agent frameworks, and tooling.

Every completion is backed by a **signed receipt** proving which worker produced which output — verifiable with OneVerify.

---

## Features

- **Drop-in OpenAI compatibility** — `chat.completions`, `embeddings`, `images`, `models` with the same request/response shapes.
- **Streaming** — robust SSE parser exposed as a cancelable, async-iterable `Stream<ChatCompletionChunk>`.
- **Typed end-to-end** — full TypeScript surface for params, responses, tool calls, and chunks. Overloaded `create()` returns the right type for `stream: true`/`false`.
- **Smart retries** — exponential backoff with jitter on `429`/`5xx`/connection errors, honoring `Retry-After`. Never retries deterministic `4xx`.
- **Per-request timeouts** — backed by `AbortController`; surfaced as `APITimeoutError`.
- **Structured errors** — a clean hierarchy mapped from HTTP status (`AuthenticationError`, `RateLimitError`, …).
- **Receipts** — automatic extraction of the signed `_receipt` for OneVerify.
- **Zero runtime dependencies** — built on global `fetch`, `ReadableStream`, and `AbortController`. ESM, Node ≥ 20.
- **Injectable `fetch`** — swap in a proxy, mock, or instrumented transport.

---

## Installation

```bash
npm install @onecompute/sdk
# pnpm add @onecompute/sdk
# yarn add @onecompute/sdk
```

Requires **Node ≥ 20** (for global `fetch` and `ReadableStream`). ESM only.

---

## Quick start

```ts
import { OneClient } from "@onecompute/sdk";

const one = new OneClient({
  apiKey: process.env.ONE_API_KEY!, // dedicated package key, or a holder session token
  // baseURL defaults to https://onecomputeai.xyz/platform/v1
});
```

### Non-streaming

```ts
const res = await one.chat.completions.create({
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: "Explain the ONE network in one sentence." }],
});

console.log(res.choices[0].message.content);
console.log(res.usage); // { prompt_tokens, completion_tokens, total_tokens }
```

### Streaming

```ts
const stream = await one.chat.completions.create({
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: "Stream me a haiku." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}

// Cancel early — the underlying request is aborted on `break` or `stream.abort()`.
```

---

## API reference

All resources are reached through a `OneClient` instance. Methods return promises; the streaming overload of `chat.completions.create` resolves to a `Stream`.

### `chat.completions.create(params)`

Create a chat completion. Overloaded on `stream`.

| Param | Type | Notes |
| --- | --- | --- |
| `model` | `string` | **Required.** Model id, e.g. `claude-haiku-4-5-20251001`. |
| `messages` | `ChatMessage[]` | **Required.** Conversation so far. |
| `temperature` | `number` | Sampling temperature. |
| `max_tokens` | `number` | Max tokens to generate. |
| `top_p` | `number` | Nucleus sampling. |
| `stop` | `string \| string[]` | Up to four stop sequences. |
| `stream` | `boolean` | `true` ⇒ returns `Stream<ChatCompletionChunk>`. |
| `tools` | `Tool[]` | Function/tool definitions. |
| `tool_choice` | `ToolChoice` | `"auto" \| "none" \| "required" \| { type, function }`. |
| `response_format` | `ResponseFormat` | `{ type: "json_object" }`, JSON Schema, or text. |
| `seed` | `number` | Deterministic sampling hint. |
| `n`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `user` | — | OpenAI-compatible extras. |

**Returns:** `Promise<OneResponse<ChatCompletion>>`, or `Promise<Stream<ChatCompletionChunk>>` when `stream: true`.

```ts
// Tool calling
const res = await one.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "What's the weather in Lisbon?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
  tool_choice: "auto",
});

const call = res.choices[0].message.tool_calls?.[0];
if (call) {
  const args = JSON.parse(call.function.arguments); // { city: "Lisbon" }
}
```

### `embeddings.create(params)`

| Param | Type | Notes |
| --- | --- | --- |
| `model` | `string` | **Required.** Embedding model id. |
| `input` | `string \| string[] \| number[] \| number[][]` | **Required.** Text(s) or token arrays. |
| `encoding_format` | `"float" \| "base64"` | Default `float`. |
| `dimensions` | `number` | Truncate output dimensions (model permitting). |
| `user` | `string` | End-user identifier. |

**Returns:** `Promise<OneResponse<EmbeddingResponse>>`.

```ts
const emb = await one.embeddings.create({
  model: "text-embedding-3-small",
  input: ["hello", "world"],
});
console.log(emb.data[0].embedding); // number[]
```

### `images.generate(params)`

| Param | Type | Notes |
| --- | --- | --- |
| `prompt` | `string` | **Required.** Image description. |
| `model` | `string` | Image model id. |
| `n` | `number` | Number of images. |
| `size` | `"256x256" \| "512x512" \| "1024x1024" \| "1792x1024" \| "1024x1792"` | Output size. |
| `quality` | `"standard" \| "hd"` | — |
| `style` | `"vivid" \| "natural"` | — |
| `response_format` | `"url" \| "b64_json"` | — |

**Returns:** `Promise<OneResponse<ImageResponse>>`.

```ts
const img = await one.images.generate({
  prompt: "an isometric data center on a floating island, soft lighting",
  size: "1024x1024",
});
console.log(img.data[0].url);
```

### `models.list()` / `models.retrieve(id)`

| Method | Params | Returns |
| --- | --- | --- |
| `models.list()` | — | `Promise<OneResponse<ModelList>>` |
| `models.retrieve(id)` | `id: string` | `Promise<OneResponse<Model>>` |

```ts
const { data } = await one.models.list();
data.forEach((m) => console.log(m.id, m.owned_by));

const model = await one.models.retrieve("claude-haiku-4-5-20251001");
```

---

## Error handling

Every failure throws a subclass of `OneError`. HTTP responses map to an `APIError` subclass by status; transport failures map to `APIConnectionError` / `APITimeoutError`.

| Class | Status | When |
| --- | --- | --- |
| `BadRequestError` | 400 / 422 | Malformed request or failed validation. |
| `AuthenticationError` | 401 | Missing or invalid API key / session token. |
| `PermissionDeniedError` | 403 | Authenticated but not allowed (e.g. lane/quota gate). |
| `NotFoundError` | 404 | Unknown model, route, or resource id. |
| `RateLimitError` | 429 | Rate limited. Exposes `retryAfter` (seconds) from `Retry-After`. |
| `InternalServerError` | ≥ 500 | Gateway or worker-side failure. |
| `APIError` | other 4xx | Generic fallback for un-modeled statuses. |
| `APIConnectionError` | — | Request never reached the gateway (DNS, reset, fetch threw). |
| `APITimeoutError` | — | Request exceeded the configured `timeout` and was aborted. |

```ts
import {
  OneClient,
  AuthenticationError,
  RateLimitError,
  APITimeoutError,
} from "@onecompute/sdk";

try {
  await one.chat.completions.create({ model: "m", messages });
} catch (err) {
  if (err instanceof AuthenticationError) {
    // refresh the key / session token
  } else if (err instanceof RateLimitError) {
    console.log(`retry after ${err.retryAfter}s`);
  } else if (err instanceof APITimeoutError) {
    // raise the client timeout or retry
  } else {
    throw err;
  }
}
```

Each `APIError` carries `status`, the raw `body`, and provider `code`/`type` when present.

---

## Retries & timeouts

**Retries.** The client automatically retries transient failures — `429`, `408`, `5xx`, and connection errors — up to `maxRetries` (default `2`). It **never** retries other `4xx`, which are deterministic.

- Backoff is **exponential with full jitter**: roughly `random(0, min(8s, 500ms · 2^attempt))` per attempt.
- A `Retry-After` header takes precedence and is honored (capped at 30s to defend against hostile values).
- `maxRetries` counts retries *after* the first attempt, so `maxRetries: 2` makes at most 3 requests.

```ts
const one = new OneClient({
  apiKey: process.env.ONE_API_KEY!,
  maxRetries: 4,   // up to 5 total attempts on transient failures
});
```

**Timeouts.** Each request is bounded by `timeout` (default `60000` ms) via an internal `AbortController`. On expiry the request is aborted and an `APITimeoutError` is thrown; timed-out attempts are retried within the retry budget. Set `timeout: 0` to disable.

```ts
const one = new OneClient({ apiKey, timeout: 15_000 });
```

You can also cancel a stream at any time:

```ts
const stream = await one.chat.completions.create({ model, messages, stream: true });
setTimeout(() => stream.abort(), 2_000); // aborts the underlying request
```

---

## Receipts & OneVerify

Every completion is backed by a signed receipt — a cryptographic proof binding the request, the model, the worker, and the output. When the gateway sends one (via the `x-one-receipt` header), the client attaches it to the response as a non-enumerable `_receipt`:

```ts
const res = await one.chat.completions.create({ model, messages });

if (res._receipt) {
  const { requestHash, model, worker, outputDigest, sig, prev } = res._receipt;
  // Verify the chain with OneVerify — see https://onecomputeai.xyz/docs
}
```

`_receipt` is non-enumerable, so it never leaks into `JSON.stringify(res)` of the completion body.

| Field | Meaning |
| --- | --- |
| `prev` | Hash of the previous receipt in this session's chain. |
| `requestHash` | Hash of the canonicalized request payload. |
| `model` | Model id that served the request. |
| `worker` | Identifier of the worker that ran inference. |
| `outputDigest` | Digest of the produced output, bound into the signature. |
| `sig` | Worker signature over the receipt fields. |

---

## Configuration reference

```ts
new OneClient(options: OneClientOptions)
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | **Required.** Package key or holder session token. |
| `baseURL` | `string` | `https://onecomputeai.xyz/platform/v1` | Gateway base URL (trailing slashes are normalized). |
| `fetch` | `typeof fetch` | global `fetch` | Inject a custom transport (proxy, mock, instrumentation). |
| `timeout` | `number` (ms) | `60000` | Per-request timeout. `0` disables it. |
| `maxRetries` | `number` | `2` | Retries on transient failures (after the first attempt). |
| `defaultHeaders` | `Record<string, string>` | `{}` | Headers merged into every request. |

Read-only properties exposed on an instance: `baseURL`, `timeout`, `maxRetries`.

---

## TypeScript notes

- **ESM only.** `"type": "module"`; the package ships `.d.ts` declarations.
- Internal relative imports use explicit `.js` extensions (NodeNext resolution).
- `chat.completions.create` is **overloaded**: `stream: true` narrows the return to `Promise<Stream<ChatCompletionChunk>>`, otherwise `Promise<OneResponse<ChatCompletion>>`.
- `OneResponse<T>` is `T & { _receipt?: Receipt }`.
- All public types are re-exported from the package root:

```ts
import type {
  ChatCompletionParams,
  ChatCompletion,
  ChatCompletionChunk,
  EmbeddingResponse,
  ImageResponse,
  ModelList,
  Receipt,
} from "@onecompute/sdk";
```

---

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # tsc, then node --test over the compiled dist/**/*.test.js
```

Tests use only the built-in `node:test` runner and `node:assert/strict` — no test framework, no runtime dependencies. All network access in tests is through an injected mock `fetch`; nothing hits the real gateway.

---

## Contributing

Issues and PRs are welcome in this repository. Please keep the zero-dependency, ESM, strict-TypeScript conventions, and add `node:test` coverage for new behavior.

---

## License

MIT © 2026 ONE Protocol · [docs](https://onecomputeai.xyz/docs) · [site](https://onecomputeai.xyz)
