// Typed surface for the ONE gateway. Shapes mirror the OpenAI REST schema so
// the SDK is a drop-in replacement; ONE-specific additions (receipts) are
// layered on top via `OneResponse`.

/* ------------------------------------------------------------------ shared */

export type Role = "system" | "user" | "assistant" | "tool";

/** A single function the model may call. */
export interface FunctionDefinition {
  name: string;
  description?: string;
  /** JSON Schema object describing the arguments. */
  parameters?: Record<string, unknown>;
}

export interface Tool {
  type: "function";
  function: FunctionDefinition;
}

/** Arguments are a JSON-encoded string, matching the OpenAI wire format. */
export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface ToolCall {
  /** Stable id used to correlate the eventual `tool` reply. */
  id: string;
  type: "function";
  function: FunctionCall;
  /** Present in streamed deltas to reassemble fragmented tool calls. */
  index?: number;
}

export interface ChatMessage {
  role: Role;
  /** `null` is valid for assistant turns that only produce tool calls. */
  content: string | null;
  /** Optional speaker name (used by some multi-agent setups). */
  name?: string;
  /** Tool calls requested by an assistant turn. */
  tool_calls?: ToolCall[];
  /** For `role: "tool"` replies — the id of the call being answered. */
  tool_call_id?: string;
  [k: string]: unknown;
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

/* ------------------------------------------------------- chat completions */

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** Up to four stop sequences. */
  stop?: string | string[];
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  /** Deterministic sampling hint. */
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Bias specific tokens (`{ "50256": -100 }`). */
  logit_bias?: Record<string, number>;
  /** Number of completions to generate. */
  n?: number;
  /** Opaque per-end-user identifier forwarded for abuse tracking. */
  user?: string;
  /** Forward arbitrary, gateway-specific fields without losing type-checking. */
  [k: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;

export interface Choice {
  index: number;
  message: ChatMessage;
  finish_reason: FinishReason;
  logprobs?: unknown | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
  system_fingerprint?: string;
}

/* ------------------------------------------------------- streaming chunks */

export interface ChoiceDelta {
  role?: Role;
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface ChunkChoice {
  index: number;
  delta: ChoiceDelta;
  finish_reason: FinishReason;
  logprobs?: unknown | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChunkChoice[];
  /** Only the final chunk carries usage, and only when requested. */
  usage?: Usage | null;
  system_fingerprint?: string;
}

/* ----------------------------------------------------------- embeddings */

export interface EmbeddingParams {
  model: string;
  input: string | string[] | number[] | number[][];
  /** `float` (default) or `base64`. */
  encoding_format?: "float" | "base64";
  /** Truncate output to this many dimensions when the model supports it. */
  dimensions?: number;
  user?: string;
  [k: string]: unknown;
}

export interface Embedding {
  object: "embedding";
  index: number;
  embedding: number[] | string;
}

export interface EmbeddingResponse {
  object: "list";
  data: Embedding[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/* --------------------------------------------------------------- images */

export interface ImageGenerateParams {
  prompt: string;
  model?: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792" | (string & {});
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  response_format?: "url" | "b64_json";
  user?: string;
  [k: string]: unknown;
}

export interface ImageData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageResponse {
  created: number;
  data: ImageData[];
}

/* --------------------------------------------------------------- models */

export interface Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: Model[];
}

/* -------------------------------------------------------------- receipts */

/**
 * Signed proof that a specific worker produced a specific output for a specific
 * request, chained to the previous receipt. Verify with OneVerify.
 */
export interface Receipt {
  /** Hash of the previous receipt in this session's chain. */
  prev: string;
  /** Hash of the canonicalized request payload. */
  requestHash: string;
  /** Model id that served the request. */
  model: string;
  /** Identifier of the worker that ran inference. */
  worker: string;
  /** Digest of the produced output, bound into the signature. */
  outputDigest: string;
  /** Worker signature over the receipt fields. */
  sig: string;
}

/**
 * A successful response value that may carry a `_receipt`. The receipt is
 * non-enumerable-friendly metadata attached by the client, not part of the
 * upstream JSON body.
 */
export type OneResponse<T> = T & { _receipt?: Receipt };
