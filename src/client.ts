// OneClient — the OpenAI-compatible entry point for the ONE gateway.
//
// It owns auth, base-URL normalization, per-request timeouts (via
// AbortController), retry with exponential backoff + jitter on transient
// failures, error mapping through `errors.ts`, and receipt extraction.

import {
  APIConnectionError,
  APITimeoutError,
  OneError,
  RateLimitError,
  fromResponse,
  parseRetryAfter,
  type ErrorBody,
  type HeaderLike,
} from "./errors.js";
import { Stream } from "./streaming.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionParams,
  EmbeddingParams,
  EmbeddingResponse,
  ImageGenerateParams,
  ImageResponse,
  Model,
  ModelList,
  OneResponse,
  Receipt,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://onecomputeai.xyz/platform/v1";

export interface OneClientOptions {
  /** Dedicated package key, or a holder session token for the Included lane. */
  apiKey: string;
  /** ONE gateway base URL. Defaults to the public gateway. */
  baseURL?: string;
  /** Inject a custom fetch (tests, proxies, instrumentation). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 60000. Set 0 to disable. */
  timeout?: number;
  /** Retry attempts on transient failures (429 / 5xx / connection). Default 2. */
  maxRetries?: number;
  /** Headers merged into every request. */
  defaultHeaders?: Record<string, string>;
}

/** Internal shape of a single request. */
interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  /** Per-call overrides. */
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const RECEIPT_HEADER = "x-one-receipt";

export class OneClient {
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;

  #apiKey: string;
  #fetch: typeof fetch;
  #defaultHeaders: Record<string, string>;

  constructor(opts: OneClientOptions) {
    if (!opts || !opts.apiKey) {
      throw new OneError("apiKey is required to construct a OneClient.", { status: 0 });
    }
    this.#apiKey = opts.apiKey;
    // Strip trailing slashes so `${base}/chat/completions` never doubles up.
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new OneError("No fetch implementation available; pass `fetch` in options.", { status: 0 });
    }
    this.timeout = opts.timeout ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.#defaultHeaders = { ...(opts.defaultHeaders ?? {}) };
  }

  /* ---------------------------------------------------------- resources */

  readonly chat = {
    completions: {
      create: ((params: ChatCompletionParams) => {
        if (params.stream) {
          return this.#createChatStream(params);
        }
        return this.#createChat(params);
      }) as ChatCompletionsCreate,
    },
  };

  readonly embeddings = {
    create: (params: EmbeddingParams): Promise<OneResponse<EmbeddingResponse>> =>
      this.#request<EmbeddingResponse>({ method: "POST", path: "/embeddings", body: params }),
  };

  readonly images = {
    generate: (params: ImageGenerateParams): Promise<OneResponse<ImageResponse>> =>
      this.#request<ImageResponse>({ method: "POST", path: "/images/generations", body: params }),
  };

  readonly models = {
    list: (): Promise<OneResponse<ModelList>> =>
      this.#request<ModelList>({ method: "GET", path: "/models" }),
    retrieve: (id: string): Promise<OneResponse<Model>> =>
      this.#request<Model>({ method: "GET", path: `/models/${encodeURIComponent(id)}` }),
  };

  /* ----------------------------------------------------- chat internals */

  async #createChat(params: ChatCompletionParams): Promise<OneResponse<ChatCompletion>> {
    return this.#request<ChatCompletion>({
      method: "POST",
      path: "/chat/completions",
      body: { ...params, stream: false },
    });
  }

  async #createChatStream(params: ChatCompletionParams): Promise<Stream<ChatCompletionChunk>> {
    const { response, controller } = await this.#raw({
      method: "POST",
      path: "/chat/completions",
      body: { ...params, stream: true },
    });
    if (!response.body) {
      throw new OneError("Streaming requested but the response had no body.", {
        status: response.status,
      });
    }
    return new Stream<ChatCompletionChunk>(response.body, controller);
  }

  /* ------------------------------------------------------ core request */

  /** JSON request with retry; parses the body and attaches any receipt. */
  async #request<T>(opts: RequestOptions): Promise<OneResponse<T>> {
    const { response } = await this.#raw(opts);
    const data = (await this.#parseJSON<T>(response)) as OneResponse<T>;
    const receipt = extractReceipt(response.headers);
    if (receipt) {
      // Attach non-enumerably so it never leaks into JSON.stringify of the body.
      Object.defineProperty(data, "_receipt", {
        value: receipt,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return data;
  }

  /**
   * Perform the HTTP call with timeout + retry. Returns the raw `Response` (for
   * streaming and receipt access) plus the controller backing the timeout so a
   * stream consumer can abort it.
   */
  async #raw(opts: RequestOptions): Promise<{ response: Response; controller: AbortController }> {
    const url = `${this.baseURL}${opts.path}`;
    const timeout = opts.timeout ?? this.timeout;
    const maxRetries = opts.maxRetries ?? this.maxRetries;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      ...this.#defaultHeaders,
      ...(opts.headers ?? {}),
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const onUserAbort = () => controller.abort();
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", onUserAbort, { once: true });
      }
      const timer =
        timeout > 0
          ? setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeout)
          : undefined;

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: opts.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        // Distinguish a timeout abort from a genuine connection failure: if the
        // caller's own signal fired, that's an intentional cancel, not a timeout.
        const userAborted = opts.signal?.aborted ?? false;
        const timedOut = controller.signal.aborted && !userAborted;
        if (userAborted) {
          // Propagate user cancellation as-is (don't wrap as a timeout).
          throw new APIConnectionError(`Request to ${opts.path} was aborted.`, err);
        }
        // Both timeouts and connection errors are retryable until the budget runs out.
        if (attempt < maxRetries) {
          await sleep(backoffDelay(attempt));
          attempt++;
          continue;
        }
        throw timedOut
          ? new APITimeoutError(`Request to ${opts.path} timed out after ${timeout}ms.`, err)
          : new APIConnectionError(`Could not reach ${opts.path}.`, err);
      } finally {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onUserAbort);
      }

      if (response.ok) {
        return { response, controller };
      }

      // Non-2xx — decide whether to retry.
      if (this.#shouldRetry(response.status) && attempt < maxRetries) {
        // Drain the body so the connection can be reused, then back off.
        await safeText(response);
        const wait = retryDelay(response.headers, attempt);
        await sleep(wait);
        attempt++;
        continue;
      }

      // Terminal error: map and throw.
      const parsed = await this.#peekErrorBody(response);
      throw fromResponse(response.status, parsed, response.headers);
    }
  }

  #shouldRetry(status: number): boolean {
    // Retry rate-limits and server errors only. Never retry other 4xx.
    return status === 429 || status === 408 || status >= 500;
  }

  async #parseJSON<T>(response: Response): Promise<T> {
    const text = await safeText(response);
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new OneError(`Failed to parse JSON response from ${response.url || "gateway"}.`, {
        status: response.status,
        cause: err,
        body: text,
      });
    }
  }

  /** Read an error body without throwing; returns parsed JSON or raw text. */
  async #peekErrorBody(response: Response): Promise<ErrorBody> {
    const text = await safeText(response);
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as ErrorBody;
    } catch {
      return text;
    }
  }
}

/* ------------------------------------------------------------ overloads */

interface ChatCompletionsCreate {
  (params: ChatCompletionParams & { stream: true }): Promise<Stream<ChatCompletionChunk>>;
  (params: ChatCompletionParams & { stream?: false }): Promise<OneResponse<ChatCompletion>>;
  (params: ChatCompletionParams): Promise<OneResponse<ChatCompletion> | Stream<ChatCompletionChunk>>;
}

/* ------------------------------------------------------------- helpers */

/** Exponential backoff with full jitter, capped at 8s. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return Math.floor(Math.random() * base);
}

/** Honor `retry-after` when present; otherwise fall back to backoff. */
function retryDelay(headers: HeaderLike, attempt: number): number {
  const retryAfter = parseRetryAfter(headers);
  if (retryAfter !== undefined) {
    // Cap server-directed waits so a hostile header can't hang the client.
    return Math.min(retryAfter * 1000, 30_000);
  }
  return backoffDelay(attempt);
}

function extractReceipt(headers: HeaderLike): Receipt | undefined {
  const raw =
    headers && typeof (headers as Headers).get === "function"
      ? (headers as Headers).get(RECEIPT_HEADER)
      : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Receipt>;
    if (
      typeof parsed.requestHash === "string" &&
      typeof parsed.outputDigest === "string" &&
      typeof parsed.sig === "string"
    ) {
      return {
        prev: parsed.prev ?? "",
        requestHash: parsed.requestHash,
        model: parsed.model ?? "",
        worker: parsed.worker ?? "",
        outputDigest: parsed.outputDigest,
        sig: parsed.sig,
      };
    }
  } catch {
    // malformed receipt header — ignore
  }
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export so `RateLimitError.retryAfter` is discoverable from the client module too.
export { RateLimitError };
