/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenAI-compatible API server that proxies to Amazon Q / CodeWhisperer
 * streaming API. Ported from kiro-gateway (Python) to TypeScript,
 * reusing the VS Code extension's existing authentication.
 */

import * as http from 'http'
import * as vscode from 'vscode'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { randomUUID } from 'crypto'
import {
    log,
    OpenAIMessage,
    OpenAIChatRequest,
    ParsedEvent,
    sessionStore,
    convStateMap,
    trimMessages,
    buildSessionKey,
    buildKiroPayload,
    streamFromCW,
    parseChunk,
    extractText,
    fetchModelList,
    readBody,
} from './serverUtils'

// ── Request handler ──────────────────────────────────────────────────────────

async function handleChatCompletions(req: OpenAIChatRequest, res: http.ServerResponse, incomingHeaders: http.IncomingHttpHeaders) {
    const model = req.model ?? 'amazon-q'

    // ── Session management ────────────────────────────────────────────────────
    //
    // Stateful mode  — client sends `X-Session-Id` header on follow-up turns.
    //   The server looks up the stored history, appends the new messages from
    //   the request body, and uses the merged list for this call.
    //
    // Stateless mode — no header present (or first turn).
    //   The server creates a new session from the full `messages` array and
    //   returns the session ID in the `X-Session-Id` response header so the
    //   client can opt in to stateful mode on the next turn.
    //
    // Either way the client always receives `X-Session-Id` in the response.
    // Existing clients that ignore the header keep working without any changes.

    const incomingSessionId = incomingHeaders['x-session-id'] as string | undefined
    let sessionId: string
    let effectiveMessages: OpenAIMessage[]

    if (incomingSessionId) {
        const session = sessionStore.get(incomingSessionId)
        if (!session) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: `Unknown session ID: ${incomingSessionId}. Start a new conversation without X-Session-Id.` } }))
            return
        }
        // In stateful mode the client sends only the new messages for this turn
        // (the latest user message plus any tool results).  Merge them into the
        // stored history so the full context is available to the model.
        const merged = sessionStore.append(incomingSessionId, req.messages, req.tools)!
        effectiveMessages = merged
        sessionId = incomingSessionId
        // Re-inject stored tools if the client didn't send them on this turn
        if (!req.tools?.length && session.tools?.length) {
            req = { ...req, tools: session.tools }
        }
        log.debug('openaiServer: stateful session %s — appended %d messages, total %d', sessionId, req.messages.length, effectiveMessages.length)
    } else {
        // First turn or stateless client — create a new session from the full array
        sessionId = sessionStore.create(req.messages, model, req.tools)
        effectiveMessages = req.messages
        log.debug('openaiServer: created session %s with %d messages', sessionId, effectiveMessages.length)
    }

    // Work with the effective (possibly merged) message list from here on
    req = { ...req, messages: effectiveMessages }

    // ── Context compression: if prior conversation hit ≥90%, start fresh ──────
    // We key by a stable hash of the system prompt + first user message so the
    // same logical "session" reuses its state across stateless HTTP calls.
    const sessionKey = buildSessionKey(req.messages)
    const prevState = convStateMap.get(sessionKey) ?? sessionStore.get(sessionId)?.convState
    if (prevState?.contextUsagePct !== undefined && prevState.contextUsagePct >= 90) {
        log.warn('openaiServer: context at %d%% — compressing history for session %s', prevState.contextUsagePct, sessionId)
        // Build a summary from the last assistant message as a best-effort proxy
        const lastAssistant = [...req.messages].reverse().find((m) => m.role === 'assistant')
        prevState.summary = lastAssistant
            ? `Last assistant response: ${extractText(lastAssistant.content).slice(0, 2000)}`
            : 'Context was compressed due to length.'
        prevState.contextUsagePct = 0
    }

    // ── Trim history to fit within model context budget ───────────────────────
    req = { ...req, messages: trimMessages(req.messages, model, prevState) }

    const conversationId = randomUUID()
    const requestId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)

    let profileArn: string | undefined
    try {
        profileArn = AuthUtil.instance.regionProfileManager?.activeRegionProfile?.arn
    } catch { /* optional */ }

    const payload = buildKiroPayload(req, conversationId, profileArn)

    // Forward max_tokens if provided
    if (req.max_tokens) {
        payload.conversationState.currentMessage.userInputMessage.maxTokens = req.max_tokens
    }

    let upstream: http.IncomingMessage
    try {
        upstream = await streamFromCW(payload)
    } catch (err: any) {
        log.error('CW API request failed: %s', err)
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }))
        return
    }

    if (upstream.statusCode !== 200) {
        const chunks: Buffer[] = []
        for await (const c of upstream) chunks.push(c as Buffer)
        const body = Buffer.concat(chunks).toString()
        log.error('CW API returned %d: %s', upstream.statusCode, body)
        res.writeHead(upstream.statusCode ?? 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Upstream ${upstream.statusCode}: ${body}` } }))
        return
    }

    const buffer = { value: '' }
    const toolCalls: any[] = []
    let currentTool: any = null
    let lastContent: string | null = null
    // Token counts from upstream usage event
    let promptTokens = 0
    let completionTokens = 0

    // Helper: handle usage + context_usage events (shared by both paths)
    const handleMetaEvent = (ev: ParsedEvent) => {
        if (ev.type === 'usage') {
            // Amazon Q may return inputTokens / outputTokens or inputTokenCount / outputTokenCount
            promptTokens = ev.data.inputTokens ?? ev.data.inputTokenCount ?? promptTokens
            completionTokens = ev.data.outputTokens ?? ev.data.outputTokenCount ?? completionTokens
        } else if (ev.type === 'context_usage') {
            const pct: number = ev.data.contextUsagePercentage ?? 0
            log.debug('openaiServer: contextUsagePercentage=%d%% session=%s', pct, sessionId)
            // Persist in both the legacy map and the session store
            const state = convStateMap.get(sessionKey) ?? { contextUsagePct: 0 }
            state.contextUsagePct = pct
            convStateMap.set(sessionKey, state)
            sessionStore.updateConvState(sessionId, { contextUsagePct: pct })
            if (pct >= 75) {
                log.warn('openaiServer: context pressure %d%% — approaching limit (session=%s)', pct, sessionId)
            }
        }
    }

    // Helper: deduplicate tool calls by ID, keeping the entry with the most
    // complete (longest) arguments string.  The upstream sometimes emits a
    // tool_start with full input AND a subsequent tool_stop for the same ID,
    // producing two entries with the same toolUseId.
    const deduplicateToolCalls = (calls: any[]): any[] => {
        const seen = new Map<string, any>()
        for (const tc of calls) {
            const existing = seen.get(tc.id)
            if (!existing || (tc.function?.arguments?.length ?? 0) > (existing.function?.arguments?.length ?? 0)) {
                seen.set(tc.id, tc)
            }
        }
        return [...seen.values()]
    }

    // Helper: store the completed assistant turn in the session so follow-up
    // requests in stateful mode have the full history available.
    const persistAssistantTurn = (content: string, calls: any[]) => {
        const dedupedCalls = deduplicateToolCalls(calls)
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: content || null }
        if (dedupedCalls.length) assistantMsg.tool_calls = dedupedCalls.map(({ _index: _i, ...rest }) => rest)
        sessionStore.append(sessionId, [assistantMsg])
    }

    if (req.stream) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Session-Id': sessionId,
        })
        let first = true

        const sendChunk = (delta: any, finishReason: string | null, usage?: any) => {
            const chunk: any = { id: requestId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] }
            if (usage) chunk.usage = usage
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }

        let streamedContent = ''
        for await (const raw of upstream) {
            buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(buffer)) {
                if (ev.type === 'content') {
                    const text = ev.data.content ?? ''
                    if (text === lastContent) continue
                    lastContent = text
                    streamedContent += text
                    const delta: any = { content: text }
                    if (first) { delta.role = 'assistant'; first = false }
                    sendChunk(delta, null)
                } else if (ev.type === 'tool_start') {
                    // Finalize any previous tool
                    if (currentTool) toolCalls.push(currentTool)
                    const toolId = ev.data.toolUseId ?? `call_${randomUUID().slice(0, 8)}`
                    const initialArgs = typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '')
                    currentTool = { id: toolId, type: 'function', function: { name: ev.data.name ?? '', arguments: initialArgs }, _index: toolCalls.length }
                    // Stream: header chunk with id, type, function.name, empty arguments
                    if (first) { sendChunk({ role: 'assistant', content: null }, null); first = false }
                    sendChunk({
                        tool_calls: [{ index: currentTool._index, id: toolId, type: 'function', function: { name: ev.data.name ?? '', arguments: '' } }]
                    }, null)
                    // If initial input already present, stream it
                    if (initialArgs) {
                        sendChunk({ tool_calls: [{ index: currentTool._index, function: { arguments: initialArgs } }] }, null)
                        currentTool.function.arguments = initialArgs
                    }
                    if (ev.data.stop) { toolCalls.push(currentTool); currentTool = null }
                } else if (ev.type === 'tool_input' && currentTool) {
                    const inp = typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '')
                    if (inp) {
                        currentTool.function.arguments += inp
                        // Stream arguments fragment
                        sendChunk({ tool_calls: [{ index: currentTool._index, function: { arguments: inp } }] }, null)
                    }
                } else if (ev.type === 'tool_stop' && currentTool) {
                    try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch { /* keep raw */ }
                    toolCalls.push(currentTool)
                    currentTool = null
                } else {
                    handleMetaEvent(ev)
                }
            }
        }
        if (currentTool) {
            try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch {}
            toolCalls.push(currentTool)
        }

        // Persist the completed assistant turn so stateful clients can continue
        persistAssistantTurn(streamedContent, toolCalls)

        // Final chunk carries usage so clients (Cline) can track token budget
        const finalUsage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
        sendChunk({}, toolCalls.length ? 'tool_calls' : 'stop', finalUsage)
        res.write('data: [DONE]\n\n')
        res.end()
    } else {
        // Non-streaming: collect full response
        let fullContent = ''
        for await (const raw of upstream) {
            buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(buffer)) {
                if (ev.type === 'content') {
                    const text = ev.data.content ?? ''
                    if (text !== lastContent) { fullContent += text; lastContent = text }
                } else if (ev.type === 'tool_start') {
                    if (currentTool) toolCalls.push(currentTool)
                    currentTool = { id: ev.data.toolUseId ?? `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: ev.data.name ?? '', arguments: typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '') } }
                    if (ev.data.stop) { toolCalls.push(currentTool); currentTool = null }
                } else if (ev.type === 'tool_input' && currentTool) {
                    currentTool.function.arguments += typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '')
                } else if (ev.type === 'tool_stop' && currentTool) {
                    try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch {}
                    toolCalls.push(currentTool); currentTool = null
                } else {
                    handleMetaEvent(ev)
                }
            }
        }
        if (currentTool) {
            try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch {}
            toolCalls.push(currentTool)
        }

        // Persist the completed assistant turn so stateful clients can continue
        persistAssistantTurn(fullContent, toolCalls)

        const dedupedToolCalls = deduplicateToolCalls(toolCalls)
        const message: any = { role: 'assistant', content: fullContent }
        if (dedupedToolCalls.length) message.tool_calls = dedupedToolCalls.map(({ _index: _i, ...rest }) => rest)
        const finishReason = dedupedToolCalls.length ? 'tool_calls' : 'stop'

        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Session-Id': sessionId })
        res.end(JSON.stringify({
            id: requestId, object: 'chat.completion', created, model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        }))
    }
}

// ── Models handler (OpenAI format) ───────────────────────────────────────────

async function handleModels(res: http.ServerResponse) {
    const created = Math.floor(Date.now() / 1000)
    const models = await fetchModelList()
    const data = models.map((m) => ({
        id: m.modelId,
        object: 'model',
        created,
        owned_by: 'amazon',
        name: m.modelName ?? m.modelId,
        description: m.description,
        context_length: m.contextTokens,
        context_window: m.contextTokens,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data }))
}

// ── Server ───────────────────────────────────────────────────────────────────

export class OpenAICompatServer {
    private server: http.Server | undefined
    private _port: number

    constructor(port = 61822) { this._port = port }
    get port() { return this._port }
    get isRunning() { return !!this.server }

    async start(): Promise<void> {
        if (this.server) return

        // Create the server but do NOT assign this.server yet — only do so after
        // listen() succeeds.  If we assigned it eagerly and listen() failed, the
        // error handler would reset this.server to undefined, but the OS socket
        // could still be in TIME_WAIT/CLOSE_WAIT.  A subsequent start() call would
        // then pass the `if (this.server) return` guard, create a new server, and
        // immediately hit EADDRINUSE even though the port looks free to the user.
        const srv = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id')
            res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id')
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

            const url = req.url ?? ''

            if (url === '/v1/models' && req.method === 'GET') { await handleModels(res); return }

            if (url === '/v1/chat/completions' && req.method === 'POST') {
                if (!AuthUtil.instance.isConnected()) {
                    res.writeHead(401, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'Not authenticated with Amazon Q' } }))
                    return
                }
                const body = await readBody(req)
                let parsed: OpenAIChatRequest
                try { parsed = JSON.parse(body) } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
                    return
                }
                if (!parsed.messages?.length) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'messages required' } }))
                    return
                }
                try {
                    await handleChatCompletions(parsed, res, req.headers)
                } catch (err: any) {
                    log.error('handleChatCompletions error: %s', err)
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ error: { message: err.message ?? 'Internal error' } }))
                    }
                }
                return
            }

            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Not found' } }))
        })

        return new Promise((resolve, reject) => {
            srv.listen(this._port, '127.0.0.1', () => {
                this.server = srv  // assign only after successful bind
                log.info('OpenAI-compatible server listening on http://127.0.0.1:%d', this._port)
                resolve()
            })
            srv.on('error', (err: NodeJS.ErrnoException) => {
                // Provide a clear, actionable error message instead of the raw
                // system error string (e.g. "listen EADDRINUSE 127.0.0.1:61822").
                const detail = err.code === 'EADDRINUSE'
                    ? `Port ${this._port} is already in use. Stop the other process using that port, or change the port in the OpenAI-Compatible Server settings.`
                    : `${err.message} (code: ${err.code ?? 'unknown'})`
                log.error('OpenAI-compatible server failed to start: %s', detail)
                reject(new Error(detail))
            })
        })
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) { resolve(); return }
            this.server.close(() => { this.server = undefined; log.info('OpenAI-compatible server stopped'); resolve() })
        })
    }
}

// ── Settings webview panel ────────────────────────────────────────────────────

function buildSettingsHtml(panel: vscode.WebviewPanel, running: boolean, port: number, autoStart: boolean): string {
    const nonce = randomUUID().replace(/-/g, '')
    const statusColor = running ? '#4caf50' : '#f44336'
    const statusLabel = running ? '● Running' : '○ Stopped'
    const toggleLabel = running ? 'Stop server' : 'Start server'
    const toggleClass = running ? 'btn-stop' : 'btn-start'

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenAI-Compatible Server</title>
  <style nonce="${nonce}">
    :root {
      --vscode-font: var(--vscode-font-family, system-ui, sans-serif);
      --radius: 6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px 28px;
      max-width: 520px;
    }
    h1 {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-badge {
      font-size: 0.85em;
      font-weight: 500;
      color: ${statusColor};
    }
    .section { margin-bottom: 20px; }
    label {
      display: block;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    input[type="number"] {
      width: 120px;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: var(--radius);
      font-size: 1em;
      font-family: var(--vscode-font);
    }
    input[type="number"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .toggle {
      position: relative;
      width: 40px;
      height: 22px;
      flex-shrink: 0;
    }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      inset: 0;
      background: var(--vscode-input-border, #555);
      border-radius: 22px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .slider::before {
      content: '';
      position: absolute;
      width: 16px; height: 16px;
      left: 3px; top: 3px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    input:checked + .slider { background: var(--vscode-button-background, #0e639c); }
    input:checked + .slider::before { transform: translateX(18px); }
    .toggle-label { font-size: 0.9em; }
    .btn-row { display: flex; gap: 10px; margin-top: 24px; }
    button {
      padding: 6px 16px;
      border: none;
      border-radius: var(--radius);
      font-size: 0.9em;
      font-family: var(--vscode-font);
      cursor: pointer;
    }
    .btn-primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .btn-start {
      background: #2e7d32;
      color: #fff;
    }
    .btn-start:hover { background: #388e3c; }
    .btn-stop {
      background: #c62828;
      color: #fff;
    }
    .btn-stop:hover { background: #d32f2f; }
    .hint {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .url-box {
      display: inline-block;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
      border-radius: var(--radius);
      padding: 4px 10px;
      margin-top: 6px;
      user-select: all;
    }
    .divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <h1>OpenAI-Compatible Server <span class="status-badge" id="statusBadge">${statusLabel}</span></h1>

  <div class="section">
    <div class="url-box" id="urlBox">http://127.0.0.1:${port}/v1</div>
  </div>

  <hr class="divider">

  <div class="section">
    <label for="portInput">Port</label>
    <input type="number" id="portInput" value="${port}" min="1024" max="65535">
    <p class="hint">If the server is running, saving will restart it on the new port.</p>
  </div>

  <div class="section">
    <div class="toggle-row">
      <label class="toggle">
        <input type="checkbox" id="autoStartToggle" ${autoStart ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <span class="toggle-label">Start automatically on extension activation</span>
    </div>
  </div>

  <div class="btn-row">
    <button class="${toggleClass}" id="toggleBtn">${toggleLabel}</button>
    <button class="btn-primary" id="saveBtn">Save settings</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()

    document.getElementById('toggleBtn').addEventListener('click', () => {
      vscode.postMessage({ command: '${running ? 'stop' : 'start'}' })
    })

    document.getElementById('saveBtn').addEventListener('click', () => {
      const port = parseInt(document.getElementById('portInput').value, 10)
      const autoStart = document.getElementById('autoStartToggle').checked
      if (isNaN(port) || port < 1024 || port > 65535) {
        alert('Port must be between 1024 and 65535.')
        return
      }
      vscode.postMessage({ command: 'save', port, autoStart })
    })

    window.addEventListener('message', (event) => {
      const msg = event.data
      if (msg.command === 'stateUpdate') {
        const badge = document.getElementById('statusBadge')
        const btn   = document.getElementById('toggleBtn')
        const urlBox = document.getElementById('urlBox')
        badge.textContent = msg.running ? '● Running' : '○ Stopped'
        badge.style.color  = msg.running ? '#4caf50' : '#f44336'
        btn.textContent    = msg.running ? 'Stop server' : 'Start server'
        btn.className      = msg.running ? 'btn-stop' : 'btn-start'
        btn.onclick        = () => vscode.postMessage({ command: msg.running ? 'stop' : 'start' })
        urlBox.textContent = 'http://127.0.0.1:' + msg.port + '/v1'
      }
    })
  </script>
</body>
</html>`
}

// ── Activation ───────────────────────────────────────────────────────────────

let serverInstance: OpenAICompatServer | undefined
let settingsPanel: vscode.WebviewPanel | undefined

function pushSettingsState(running: boolean, port: number) {
    settingsPanel?.webview.postMessage({ command: 'stateUpdate', running, port })
}

export function activateOpenAIServer(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('amazonQ')
    const port = config.get<number>('openAICompatServer.port', 61822)
    const autoStart = config.get<boolean>('openAICompatServer.autoStart', true)

    serverInstance = new OpenAICompatServer(port)

    context.subscriptions.push(
        vscode.commands.registerCommand('aws.amazonq.openaiServer.start', async () => {
            try {
                await serverInstance!.start()
                pushSettingsState(true, serverInstance!.port)
                void vscode.window.showInformationMessage(`Amazon Q OpenAI-compatible server on http://127.0.0.1:${serverInstance!.port}`)
            } catch (err: any) { void vscode.window.showErrorMessage(`Failed to start: ${err.message}`) }
        }),

        vscode.commands.registerCommand('aws.amazonq.openaiServer.stop', async () => {
            await serverInstance!.stop()
            pushSettingsState(false, serverInstance!.port)
            void vscode.window.showInformationMessage('Amazon Q OpenAI-compatible server stopped')
        }),

        vscode.commands.registerCommand('aws.amazonq.openaiServer.settings', () => {
            // Reuse existing panel if open
            if (settingsPanel) {
                settingsPanel.reveal(vscode.ViewColumn.Active)
                return
            }

            const cfg = vscode.workspace.getConfiguration('amazonQ')
            const currentPort = cfg.get<number>('openAICompatServer.port', 61822)
            const currentAutoStart = cfg.get<boolean>('openAICompatServer.autoStart', true)
            const running = serverInstance?.isRunning ?? false

            settingsPanel = vscode.window.createWebviewPanel(
                'amazonq.openaiServerSettings',
                'OpenAI-Compatible Server',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            )

            settingsPanel.webview.html = buildSettingsHtml(settingsPanel, running, currentPort, currentAutoStart)

            settingsPanel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === 'start') {
                    try {
                        await serverInstance!.start()
                        pushSettingsState(true, serverInstance!.port)
                        void vscode.window.showInformationMessage(`Server started on http://127.0.0.1:${serverInstance!.port}`)
                    } catch (err: any) {
                        void vscode.window.showErrorMessage(`Failed to start: ${err.message}`)
                    }
                } else if (msg.command === 'stop') {
                    await serverInstance!.stop()
                    pushSettingsState(false, serverInstance!.port)
                } else if (msg.command === 'save') {
                    const newPort: number = msg.port
                    const newAutoStart: boolean = msg.autoStart
                    const c = vscode.workspace.getConfiguration('amazonQ')
                    await c.update('openAICompatServer.port', newPort, vscode.ConfigurationTarget.Global)
                    await c.update('openAICompatServer.autoStart', newAutoStart, vscode.ConfigurationTarget.Global)

                    // Recreate the server instance with the new port so that the
                    // next start() call (or an immediate restart below) actually
                    // binds the port the user chose.  Previously only the VS Code
                    // config was updated; serverInstance._port was never changed,
                    // so the old port was always used until the extension host
                    // was fully reloaded.
                    const wasRunning = serverInstance?.isRunning ?? false
                    await serverInstance?.stop()
                    serverInstance = new OpenAICompatServer(newPort)

                    if (wasRunning) {
                        try {
                            await serverInstance.start()
                            pushSettingsState(true, newPort)
                            void vscode.window.showInformationMessage(
                                `Settings saved. Server restarted on http://127.0.0.1:${newPort}`
                            )
                        } catch (err: any) {
                            pushSettingsState(false, newPort)
                            void vscode.window.showErrorMessage(
                                `Settings saved, but failed to restart on port ${newPort}: ${err.message}`
                            )
                        }
                    } else {
                        pushSettingsState(false, newPort)
                        void vscode.window.showInformationMessage(`Settings saved. Port set to ${newPort}.`)
                    }
                }
            }, undefined, context.subscriptions)

            settingsPanel.onDidDispose(() => { settingsPanel = undefined }, undefined, context.subscriptions)
        }),

        { dispose: () => serverInstance?.stop() }
    )

    if (autoStart) {
        serverInstance.start().catch((err) => log.error('Auto-start failed: %s', err))
    }
}
