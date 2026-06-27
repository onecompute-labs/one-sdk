# Changelog

All notable changes to `@onecompute/sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-25

Initial release.

### Added
- `OneClient` — OpenAI-compatible client for the ONE gateway (default `https://platform.onecompute.xyz/v1`).
- `chat.completions.create` with both non-streaming responses and a `Stream<ChatCompletionChunk>` async-iterable for `stream: true`.
- `embeddings.create`, `images.generate`, `models.list`, and `models.retrieve`.
- Robust SSE parser tolerant of chunk-boundary splits, comments/keep-alives, and malformed frames.
- Typed error hierarchy (`AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `BadRequestError`, `RateLimitError`, `InternalServerError`, `APIConnectionError`, `APITimeoutError`) mapped from HTTP status, with `Retry-After` parsing.
- Automatic retries with exponential backoff + jitter on `429`/`408`/`5xx`/connection errors; `4xx` (except `429`) never retried.
- Configurable `baseURL`, `timeout`, `maxRetries`, `defaultHeaders`, and injectable `fetch`.
- Receipt extraction from the gateway response for use with [OneVerify](https://docs.onecompute.xyz).
- Full TypeScript type surface and bundled declarations.
- 56 unit tests (all network mocked via injected `fetch`).

[Unreleased]: https://github.com/onecomputexyz/one-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/onecomputexyz/one-sdk/releases/tag/v0.1.0
