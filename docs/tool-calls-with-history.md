# Handling Multiple Tool Calls with Conversation History

This guide covers two ways to run an agentic loop against the server. The **stateful mode** is the recommended approach — the server manages history for you. The **stateless mode** is available for clients that already maintain their own message array.

---

## Stateful mode (recommended)

The server stores the full conversation history. Your client only ever sends the new messages for the current turn — the latest user message plus any tool results. All the bookkeeping (alternating-role invariants, tool-result matching, context trimming) is handled server-side.

### How it works

1. Send the first request normally, with no special header.
2. The server returns an `X-Session-Id` response header.
3. On every subsequent request, send **only the new messages** and include `X-Session-Id` in the request headers.
4. The server merges the new messages into the stored history and calls the model with the full context.

### Minimal agentic loop

```js
async function agentLoop(systemPrompt, userMessage, tools) {
  let sessionId = null

  // Turn 1 — start the conversation
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userMessage },
  ]

  while (true) {
    const headers = { 'Content-Type': 'application/json' }
    if (sessionId) headers['X-Session-Id'] = sessionId

    const response = await fetch('http://127.0.0.1:61822/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4.5', messages, tools, stream: false }),
    })

    // Capture the session ID from the first response
    if (!sessionId) sessionId = response.headers.get('x-session-id')

    const data = await response.json()
    const msg    = data.choices[0].message
    const finish = data.choices[0].finish_reason

    if (finish === 'stop') {
      return msg.content  // done
    }

    if (finish === 'tool_calls') {
      // Build tool result messages — one per call
      messages = []
      for (const tc of msg.tool_calls) {
        const result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments))
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        })
      }
      // Loop — send only the tool results; the server has everything else
      continue
    }

    throw new Error(`Unexpected finish_reason: ${finish}`)
  }
}
```

Notice that after the first turn, `messages` contains **only the tool results** for that round. The server holds the rest.

### curl example

```bash
# Turn 1 — start the conversation, capture the session ID
SESSION=$(curl -si http://127.0.0.1:61822/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "List files in /tmp"}],
    "tools": [{"type":"function","function":{"name":"list_files","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}],
    "stream": false
  }' | tee /dev/stderr | grep -i x-session-id | awk '{print $2}' | tr -d '\r')

# Turn 2 — send only the tool result
curl http://127.0.0.1:61822/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SESSION" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role":"tool","tool_call_id":"call_abc","content":"a.txt, b.txt"}],
    "stream": false
  }'
```

---

## Stateless mode (existing behaviour)

If you prefer to manage history yourself, or if you are using a client library that already does so (Cline, Continue, etc.), nothing changes. Simply send the complete `messages` array on every request and omit the `X-Session-Id` header. The server still creates a session internally and returns the header, but you can ignore it.

```js
// Stateless — send the full history every time
const messages = []

async function turn(newMessages) {
  messages.push(...newMessages)
  const response = await fetch('http://127.0.0.1:61822/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4.5', messages, tools, stream: false }),
  }).then(r => r.json())

  const msg = response.choices[0].message
  messages.push(msg)  // keep the assistant turn in history
  return response
}
```

---

## Message format reference

### Single tool call

```
user      → "What files are in /tmp?"
assistant → tool_calls: [list_files({path:"/tmp"})]   finish_reason: "tool_calls"
tool      → "a.txt, b.txt"                            tool_call_id: <id>
assistant → "The directory contains a.txt and b.txt." finish_reason: "stop"
```

### Multiple tool calls in one turn

The model can request several tools at once. Return one `tool` message per call.

```json
[
  { "role": "assistant", "content": null,
    "tool_calls": [
      { "id": "call_1", "type": "function",
        "function": { "name": "read_file",  "arguments": "{\"path\":\"config.json\"}" } },
      { "id": "call_2", "type": "function",
        "function": { "name": "list_files", "arguments": "{\"path\":\"/tmp\"}" } }
    ] },
  { "role": "tool", "content": "{\"debug\":true}", "tool_call_id": "call_1" },
  { "role": "tool", "content": "a.txt, b.txt",     "tool_call_id": "call_2" }
]
```

In stateful mode you send only those `tool` messages on the next request. In stateless mode you append them to your full history array.

---

## Detecting tool calls in streaming responses

Tool call data arrives as incremental `tool_calls` deltas. Accumulate `function.arguments` across chunks before parsing — the JSON is not complete until `finish_reason: "tool_calls"` arrives.

```js
let sessionId = null
let toolCalls = {}

const response = await fetch('http://127.0.0.1:61822/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-4.5', messages, tools, stream: true }),
})

sessionId = response.headers.get('x-session-id')

for await (const line of response.body) {
  const text = line.toString().trim()
  if (!text.startsWith('data: ') || text === 'data: [DONE]') continue
  const chunk = JSON.parse(text.slice(6))
  const delta  = chunk.choices[0].delta
  const finish = chunk.choices[0].finish_reason

  for (const tc of delta.tool_calls ?? []) {
    if (!toolCalls[tc.index]) {
      toolCalls[tc.index] = { id: tc.id, name: tc.function?.name ?? '', arguments: '' }
    }
    toolCalls[tc.index].arguments += tc.function?.arguments ?? ''
  }

  if (finish === 'tool_calls') {
    for (const tc of Object.values(toolCalls)) {
      const args = JSON.parse(tc.arguments)
      // execute tool and send result back with X-Session-Id
    }
  }
}
```

---

## Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Sending `X-Session-Id` on the first request | `400 Unknown session ID` | Omit the header on the first turn; the server creates the session |
| Reusing a session ID after 2 hours of inactivity | `400 Unknown session ID` | Sessions expire after 2 hours; start a new conversation |
| Missing a `tool` message for one of the `tool_calls` | Model gets confused or loops | Return one `tool` message per `tool_call_id` |
| Parsing `arguments` before the stream ends | `JSON.parse` throws on partial JSON | Accumulate all argument chunks; parse only after `finish_reason: "tool_calls"` |
| Not including `tool_call_id` in the `tool` message | Server cannot match result to call | Always echo back the exact `id` from the `tool_calls` entry |

---

## Context limits

Sessions expire after **2 hours** of inactivity. The server automatically trims old messages when the conversation approaches the model's context limit, and compresses history to a summary if context pressure reaches 90%.

| Model | Context window | History budget |
|---|---|---|
| `amazon-q` | 160k tokens | 128k tokens |
| `claude-sonnet-4.6` | 200k tokens | 160k tokens |
| `claude-sonnet-4.5` | 200k tokens | 160k tokens |
| `claude-haiku-4.5` | 260k tokens | 208k tokens |

To avoid premature compression, keep tool results concise — truncate large file contents or command outputs before adding them to the `content` field.
