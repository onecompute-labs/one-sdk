// @onecompute/sdk — OpenAI-compatible TypeScript client for the ONE network.
// "Hold $ONE, AI is yours."
//
// Public barrel. Import everything from here:
//
//   import { OneClient, type ChatCompletion, RateLimitError } from "@onecompute/sdk";

export { OneClient, DEFAULT_BASE_URL, backoffDelay } from "./client.js";
export type { OneClientOptions } from "./client.js";

export { Stream } from "./streaming.js";
export { parseSSE } from "./sse.js";

export {
  OneError,
  APIError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APITimeoutError,
  fromResponse,
  parseRetryAfter,
} from "./errors.js";
export type { ErrorBody, HeaderLike } from "./errors.js";

export type {
  Role,
  ChatMessage,
  Tool,
  ToolChoice,
  ToolCall,
  FunctionCall,
  FunctionDefinition,
  ResponseFormat,
  ChatCompletionParams,
  ChatCompletion,
  Choice,
  Usage,
  FinishReason,
  ChatCompletionChunk,
  ChunkChoice,
  ChoiceDelta,
  EmbeddingParams,
  Embedding,
  EmbeddingResponse,
  ImageGenerateParams,
  ImageData,
  ImageResponse,
  Model,
  ModelList,
  Receipt,
  OneResponse,
} from "./types.js";

// Back-compat alias: the original scaffold exported `ChatParams`.
export type { ChatCompletionParams as ChatParams } from "./types.js";
