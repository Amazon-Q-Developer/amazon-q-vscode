# Amazon Q Anthropic-Compatible API Server

A local HTTP server that exposes the full [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) surface, backed by Amazon Q / CodeWhisperer. This lets any tool or SDK that targets the Anthropic API use Amazon Q as the model backend — no Anthropic account or API key required.

## Quick start

The server starts automatically on port **61823** when the extension activates. Point your Anthropic SDK client at it:

```python
import anthropic

client = anthropic.Anthropic(
    api_key="dummy",          # any non-empty string; auth is handled by the extension
    base_url="http://127.0.0.1:61823",
)

message = client.messages.create(
    model="claude-sonnet-4.5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude!"}],
)
print(message.content[0].text)
```

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:61823",
});

const msg = await client.messages.create({
  model: "claude-sonnet-4.5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Implemented endpoints

### Messages API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Create a message (streaming + non-streaming) |
| `POST` | `/v1/messages/count_tokens` | Count tokens (best-effort estimation) |
| `POST` | `/v1/messages/batches` | Submit an async batch |
| `GET` | `/v1/messages/batches` | List batches |
| `GET` | `/v1/messages/batches/:id` | Get batch status |
| `GET` | `/v1/messages/batches/:id/results` | Stream batch results (JSONL) |
| `POST` | `/v1/messages/batches/:id/cancel` | Cancel a batch |
| `DELETE` | `/v1/messages/batches/:id` | Delete a batch |

### Models API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/models/:id` | Get a single model |

### Files API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/files` | Upload a file (multipart/form-data) |
| `GET` | `/v1/files` | List files |
| `GET` | `/v1/files/:id` | Get file metadata |
| `GET` | `/v1/files/:id/content` | Download file content |
| `DELETE` | `/v1/files/:id` | Delete a file |

Files are stored in-memory for the lifetime of the extension session.

### Skills API (local registry)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/skills` | Create a skill (reusable tool definition) |
| `GET` | `/v1/skills` | List skills |
| `GET` | `/v1/skills/:id` | Get a skill |
| `PUT` | `/v1/skills/:id` | Update a skill |
| `DELETE` | `/v1/skills/:id` | Delete a skill |

Skills are stored in-memory. When an agent references skill IDs, those skills are automatically injected as tools into the model request.

### Agents API (local registry)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/agents` | Create an agent (model + system prompt + skills) |
| `GET` | `/v1/agents` | List agents |
| `GET` | `/v1/agents/:id` | Get an agent |
| `PUT` | `/v1/agents/:id` | Update an agent |
| `DELETE` | `/v1/agents/:id` | Delete an agent |

### Environments API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/environments` | Create an environment config (Docker image + memory) |
| `GET` | `/v1/environments` | List environments |
| `GET` | `/v1/environments/:id` | Get an environment |
| `PUT` | `/v1/environments/:id` | Update an environment |
| `DELETE` | `/v1/environments/:id` | Delete an environment |

### Sessions API (Docker-backed)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/sessions` | Create a session (starts a Docker container) |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/:id` | Get session status |
| `GET` | `/v1/sessions/:id/stream` | SSE stream of session events |
| `DELETE` | `/v1/sessions/:id` | Stop and delete a session |

Sessions require Docker and must be explicitly enabled (see Configuration). When Docker is disabled, all session endpoints return a `501 not_supported_error` with a clear message.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `amazonQ.anthropicServer.autoStart` | `true` | Auto-start on extension activation |
| `amazonQ.anthropicServer.port` | `61823` | Port for the server |
| `amazonQ.anthropicServer.dockerEnabled` | `false` | Enable Docker-backed Sessions API |
| `amazonQ.anthropicServer.defaultEnvironmentImage` | `ubuntu:24.04` | Default Docker image for sessions |
| `amazonQ.anthropicServer.containerMemoryMb` | `512` | Memory limit (MB) per container |

## VS Code commands

- **Amazon Q: Start Anthropic-Compatible Server**
- **Amazon Q: Stop Anthropic-Compatible Server**

## Streaming

The server emits proper Anthropic SSE events:

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
```

Tool use blocks stream as `input_json_delta` events, matching the Anthropic SDK's expected format.

## Session management (stateful conversations)

The server supports the same `X-Session-Id` header pattern as the OpenAI-compatible server:

1. First request: server creates a session, returns `X-Session-Id` in the response header.
2. Subsequent turns: send only the new messages + `X-Session-Id` header. The server merges them into the stored history.
3. Stateless mode: send the full `messages` array every request (ignore the header).

## Message Batches

Batches are processed in-process by fanning out individual requests to Amazon Q sequentially. The client sees the full async API (submit → poll → retrieve results), but the proxy handles the fan-out synchronously in the background.

```python
batch = client.messages.batches.create(requests=[
    {"custom_id": "req-1", "params": {"model": "claude-sonnet-4.5", "max_tokens": 100, "messages": [...]}},
    {"custom_id": "req-2", "params": {"model": "claude-sonnet-4.5", "max_tokens": 100, "messages": [...]}},
])
# Poll until ended
while batch.processing_status == "in_progress":
    time.sleep(1)
    batch = client.messages.batches.retrieve(batch.id)
# Stream results
for result in client.messages.batches.results(batch.id):
    print(result.custom_id, result.result.message.content)
```

## Architecture

```
┌──────────────────────┐     ┌─────────────────────────┐     ┌──────────────────────┐
│  Anthropic SDK /      │────▶│  Anthropic-compat        │────▶│  Amazon Q / CW       │
│  any Anthropic client │     │  server :61823           │     │  generateAssistant   │
│                       │◀────│  (in-process)            │◀────│  Response (SSE)      │
└──────────────────────┘     └──────────┬──────────────┘     └──────────────────────┘
                                         │ shared utils
                              ┌──────────┴──────────────┐
                              │  serverUtils.ts          │
                              │  SessionStore            │
                              │  trimMessages            │
                              │  buildKiroPayload        │
                              │  parseChunk              │
                              └──────────┬──────────────┘
                                         │ also used by
                              ┌──────────┴──────────────┐
                              │  openaiServer.ts         │
                              │  OpenAI-compat :61822    │
                              └─────────────────────────┘
```

### File layout

| File | Purpose |
|------|---------|
| `packages/amazonq/src/serverUtils.ts` | Shared types, SessionStore, context trimming, Amazon Q HTTP client, SSE parser |
| `packages/amazonq/src/anthropicServer.ts` | Full Anthropic API implementation |
| `packages/amazonq/src/openaiServer.ts` | OpenAI-compatible API (refactored to use serverUtils) |
| `packages/amazonq/src/extensionNode.ts` | Activates both servers on extension startup |

### Request flow

1. Client sends an Anthropic-format request to `POST /v1/messages`
2. `anthropicServer.ts` converts Anthropic content blocks → OpenAI message format
3. `serverUtils.buildKiroPayload()` converts OpenAI format → Amazon Q `generateAssistantResponse` payload
4. Amazon Q streams back SSE events
5. `serverUtils.parseChunk()` parses the raw SSE bytes
6. `anthropicServer.ts` converts the parsed events → Anthropic SSE events (streaming) or a `Message` object (non-streaming)

### Content block mapping

| Anthropic type | Handling |
|----------------|----------|
| `text` | Passed through as message text |
| `tool_use` | Converted to OpenAI `tool_calls` format |
| `tool_result` | Converted to OpenAI `tool` role messages |
| `image` | Replaced with `[image]` placeholder (Amazon Q doesn't accept raw images via this path) |
| `document` | Text content extracted; base64 replaced with `[document]` |
| `thinking` / `redacted_thinking` | Skipped (internal to model) |

## Limitations

- **Token counting** (`/v1/messages/count_tokens`) is a best-effort estimate (~4 chars/token). It does not call the upstream API.
- **Cache control** (`cache_control` fields) is accepted but ignored — Amazon Q manages its own caching.
- **Image inputs** are not forwarded to the model; they are replaced with a `[image]` placeholder.
- **Sessions** require Docker and `amazonQ.anthropicServer.dockerEnabled = true`. Without Docker, all session endpoints return `501`.
- **Files** are stored in-memory and lost when the extension host restarts.
- **Skills/Agents/Environments** are stored in-memory and lost on restart. Persistence across sessions is not yet implemented.
