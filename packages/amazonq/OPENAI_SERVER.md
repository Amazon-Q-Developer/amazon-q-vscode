# Amazon Q OpenAI-Compatible Server

A custom build of the [Amazon Q VS Code extension](https://marketplace.visualstudio.com/items?itemName=AmazonWebServices.amazon-q-vscode) that exposes a local OpenAI-compatible API server, allowing tools like **Cline**, **Continue**, **Open Interpreter**, and any OpenAI SDK client to use Amazon Q as a backend.

## Features

- Local HTTP server on `http://127.0.0.1:61822` (configurable)
- OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints
- Streaming and non-streaming responses
- Tool/function calling support
- Reuses the extension's existing Amazon Q authentication (SSO / Builder ID)
- Auto-starts on extension activation

## Available Models

| Model ID | Description |
|---|---|
| `amazon-q` | Default Amazon Q model |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4.5` | Claude Haiku 4.5 |

## Setup

### Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.83+
- [Node.js](https://nodejs.org/) 18+
- An Amazon Q subscription (Pro or Builder ID)
- **Uninstall the official Amazon Q extension first** — this custom build uses the same extension ID

### Building

```bash
# Clone the repo
git clone https://github.com/aws/aws-toolkit-vscode.git
cd aws-toolkit-vscode

# Install dependencies
npm install

# Build (from the amazonq package directory)
cd packages/amazonq
npx webpack --mode development

# Package the VSIX
npx vsce package --no-dependencies --skip-license --allow-missing-repository \
    --ignoreFile ../.vscodeignore.packages -o amazon-q-openai.vsix
```

> **Note:** If `esbuild` is blocked by group policy on your machine, the `webBase` target
> will fail with `node:http` errors — this is fine. Only the `main` target (extensionNode.js)
> is needed for desktop VS Code.

### Installing

```bash
code --install-extension amazon-q-openai.vsix --force
```

Then reload VS Code. Sign in to Amazon Q through the sidebar if not already authenticated.

### Important Build Notes

- The **publisher must be lowercase** (`amazonwebservices`) in `package.json`. VS Code lowercases the publisher at runtime, and the extension validates its own ID at startup. Using `AmazonWebServices` (mixed case) will cause: `unexpected extension id: AmazonWebServices.amazon-q-vscode`.
- The `activateOpenAIServer()` call must happen **before** `activateAmazonQNode()` in the activation chain. The LSP/telemetry initialization in `activateAmazonQNode` can block for a long time, preventing the server from starting.
- The extension ID must remain `amazonwebservices.amazon-q-vscode` for SSO authentication to work (the OIDC client registration and URI callback handler are tied to this ID).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `amazonQ.openAICompatServer.autoStart` | `true` | Auto-start the server on extension activation |
| `amazonQ.openAICompatServer.port` | `61822` | Port for the local server |

### VS Code Commands

- **Amazon Q: Start OpenAI-Compatible Server** — manually start the server
- **Amazon Q: Stop OpenAI-Compatible Server** — stop the server

## Usage with Cline

In Cline settings, set:
- **API Provider:** OpenAI Compatible
- **Base URL:** `http://127.0.0.1:61822/v1` ⚠️ **The `/v1` suffix is required!** Cline does not add it automatically.
- **API Key:** `dummy` (any non-empty string; auth is handled by the extension)
- **Model:** `claude-sonnet-4.6` (or any model from the list above)

> **Common mistake:** If you set the base URL to `http://127.0.0.1:61822` without `/v1`,
> Cline will call `http://127.0.0.1:61822/chat/completions` instead of
> `http://127.0.0.1:61822/v1/chat/completions` and get a 404 error.

## Usage with Continue

In `~/.continue/config.json`:

```json
{
  "models": [{
    "title": "Amazon Q",
    "provider": "openai",
    "model": "claude-sonnet-4.5",
    "apiBase": "http://127.0.0.1:61822/v1",
    "apiKey": "dummy"
  }]
}
```

## Usage with curl

```bash
# List models
curl http://127.0.0.1:61822/v1/models

# Chat completion
curl http://127.0.0.1:61822/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Cline /      │────▶│ OpenAI-compat    │────▶│ Amazon Q / CW       │
│ Continue /   │     │ server :61822    │     │ streaming API       │
│ any client   │◀────│ (in-process)     │◀────│ (generateAssistant  │
└─────────────┘     └──────────────────┘     │  Response)          │
                           │                  └─────────────────────┘
                           │ reuses
                    ┌──────┴───────┐
                    │ VS Code ext  │
                    │ auth (SSO /  │
                    │ Builder ID)  │
                    └──────────────┘
```

The server runs in-process within the VS Code extension host. It translates OpenAI-format requests into Amazon Q's `generateAssistantResponse` streaming API format, and converts the SSE response back to OpenAI-compatible chunks.

## Files Changed (from upstream)

| File | Change |
|---|---|
| `packages/amazonq/src/openaiServer.ts` | New — the OpenAI-compatible server |
| `packages/amazonq/src/extensionNode.ts` | Import and call `activateOpenAIServer` early in activation |
| `packages/amazonq/package.json` | Added settings, commands, lowercase publisher |
| `packages/core/src/shared/extensionIds.ts` | No change needed if publisher stays `amazonwebservices` |

## Further reading

- [Handling multiple tool calls with conversation history](../../docs/tool-calls-with-history.md)

## License

[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0)
