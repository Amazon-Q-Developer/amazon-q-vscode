/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenAI-compatible API server that proxies to Amazon Q / CodeWhisperer
 * streaming API. Ported from kiro-gateway (Python) to TypeScript,
 * reusing the VS Code extension's existing authentication.
 */

import * as http from 'http'
import * as https from 'https'
import * as vscode from 'vscode'
import { AuthUtil, codeWhispererClient } from 'aws-core-vscode/codewhisperer'
import { getLogger } from 'aws-core-vscode/shared'
import { randomUUID } from 'crypto'

const log = getLogger()

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
    role: string
    content: any
    tool_calls?: any[]
    tool_call_id?: string
}

interface OpenAITool {
    type: string
    function?: { name: string; description?: string; parameters?: any }
}

interface OpenAIChatRequest {
    model?: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    stream?: boolean
    max_tokens?: number
}

// ── Context window limits per model (chars, ~4 chars/token) ──────────────────

const MODEL_CONTEXT_CHARS: Record<string, number> = {
    'amazon-q':          640_000,   // ~160k tokens
    'claude-sonnet-4.6': 800_000,   // ~200k tokens
    'claude-sonnet-4.5': 800_000,
    'claude-sonnet-4':   800_000,
    'claude-haiku-4.5':  1_040_000, // ~260k tokens
}
const DEFAULT_CONTEXT_CHARS = 640_000
// Reserve ~20% for the response
const HISTORY_BUDGET_RATIO = 0.8

// ── Per-conversation context pressure tracker ─────────────────────────────────

interface ConvState {
    /** Last contextUsagePercentage received from upstream (0-100) */
    contextUsagePct: number
    /** Summary injected when context was compressed */
    summary?: string
}

// ── Server-side session store ─────────────────────────────────────────────────
//
// Clients that want a stateless single-turn experience can keep sending the
// full `messages` array on every request (existing behaviour, no session ID
// needed).
//
// Clients that want the server to manage history can:
//   1. Send the first request normally — the server creates a session and
//      returns its ID in the `X-Session-Id` response header.
//   2. On subsequent turns, send ONLY the new messages (the latest user
//      message plus any tool results) together with the `X-Session-Id`
//      request header.  The server merges them into the stored history.
//
// This hides all of the alternating-role bookkeeping, tool-result matching,
// and context-trimming from the client.

interface Session {
    messages: OpenAIMessage[]
    model: string
    tools?: OpenAITool[]
    convState: ConvState
    lastUsed: number
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

class SessionStore {
    private sessions = new Map<string, Session>()

    create(messages: OpenAIMessage[], model: string, tools?: OpenAITool[]): string {
        const id = randomUUID()
        this.sessions.set(id, { messages: [...messages], model, tools, convState: { contextUsagePct: 0 }, lastUsed: Date.now() })
        this._evict()
        return id
    }

    get(id: string): Session | undefined {
        const s = this.sessions.get(id)
        if (s) s.lastUsed = Date.now()
        return s
    }

    /** Append new messages to an existing session and return the full history. */
    append(id: string, newMessages: OpenAIMessage[], tools?: OpenAITool[]): OpenAIMessage[] | undefined {
        const s = this.sessions.get(id)
        if (!s) return undefined
        s.messages.push(...newMessages)
        if (tools?.length) s.tools = tools
        s.lastUsed = Date.now()
        return s.messages
    }

    updateConvState(id: string, patch: Partial<ConvState>) {
        const s = this.sessions.get(id)
        if (s) Object.assign(s.convState, patch)
    }

    private _evict() {
        const now = Date.now()
        for (const [id, s] of this.sessions) {
            if (now - s.lastUsed > SESSION_TTL_MS) this.sessions.delete(id)
        }
    }
}

const sessionStore = new SessionStore()
const convStateMap = new Map<string, ConvState>()

// ── History trimming (sliding window) ────────────────────────────────────────

/**
 * Trims the message list to fit within the model's context budget.
 * System messages are always kept. Non-system messages are dropped oldest-first
 * until the total character count fits within the budget.
 * If a prior conversation was compressed (summary injected), that summary is
 * prepended as a synthetic system message.
 */
function trimMessages(messages: OpenAIMessage[], model: string, convState?: ConvState): OpenAIMessage[] {
    const budgetChars = Math.floor((MODEL_CONTEXT_CHARS[model] ?? DEFAULT_CONTEXT_CHARS) * HISTORY_BUDGET_RATIO)

    const systemMsgs = messages.filter((m) => m.role === 'system')
    const nonSystem = messages.filter((m) => m.role !== 'system')

    // If context was previously compressed, inject the summary as a system message
    const extraSystem: OpenAIMessage[] = convState?.summary
        ? [{ role: 'system', content: `[Previous conversation summary]\n${convState.summary}` }]
        : []

    let used = [...systemMsgs, ...extraSystem].reduce((n, m) => n + extractText(m.content).length, 0)
    const kept: OpenAIMessage[] = []

    // Walk newest → oldest, keep as many as fit.
    // Use a hard budget cutoff: once we can't fit a message, stop — older messages
    // are less useful and keeping non-contiguous history breaks the alternating
    // role invariant that Amazon Q's API requires.
    for (let i = nonSystem.length - 1; i >= 0; i--) {
        const len = extractText(nonSystem[i].content).length
        if (used + len > budgetChars) {
            log.debug('openaiServer: dropping message %d (role=%s, len=%d) — budget exhausted', i, nonSystem[i].role, len)
            break
        }
        kept.unshift(nonSystem[i])
        used += len
    }

    // Ensure the kept slice starts with a 'user' message.
    // Trimming can leave an orphaned 'tool' result or 'assistant' message at the
    // front (its paired assistant tool_call was dropped), which Amazon Q rejects.
    while (kept.length && kept[0].role !== 'user') {
        log.debug('openaiServer: dropping leading %s message to restore user-first invariant', kept[0].role)
        kept.shift()
    }
    // Also drop any leading 'tool' messages (role==='tool') — they must follow an assistant tool_call
    while (kept.length && kept[0].role === 'tool') {
        log.debug('openaiServer: dropping leading tool-result message (no preceding tool_call)')
        kept.shift()
    }

    const dropped = nonSystem.length - kept.length
    if (dropped > 0) {
        log.warn('openaiServer: trimmed %d messages to fit %d-char budget (model=%s)', dropped, budgetChars, model)
    }

    return [...systemMsgs, ...extraSystem, ...kept]
}

// ── Session key (stable ID for a logical conversation) ───────────────────────

function buildSessionKey(messages: OpenAIMessage[]): string {
    const system = messages.find((m) => m.role === 'system')
    const firstUser = messages.find((m) => m.role === 'user')
    const raw = extractText(system?.content ?? '') + '|' + extractText(firstUser?.content ?? '').slice(0, 200)
    // Simple djb2 hash — no crypto needed, just needs to be stable
    let h = 5381
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i)
    return (h >>> 0).toString(16)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(content: any): string {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b.type === 'text' || b.text)
            .map((b: any) => b.text ?? '')
            .join('')
    }
    return String(content)
}

function sanitizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema
    const out: any = {}
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'additionalProperties') continue
        if (k === 'required' && Array.isArray(v) && v.length === 0) continue
        if (k === 'properties' && typeof v === 'object' && v !== null) {
            out[k] = Object.fromEntries(
                Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)])
            )
        } else if (Array.isArray(v)) {
            out[k] = v.map((i: any) => (typeof i === 'object' ? sanitizeSchema(i) : i))
        } else if (typeof v === 'object' && v !== null) {
            out[k] = sanitizeSchema(v)
        } else {
            out[k] = v
        }
    }
    return out
}

// ── Payload builder (OpenAI → Kiro/CW format) ───────────────────────────────

function buildKiroPayload(req: OpenAIChatRequest, conversationId: string, profileArn?: string) {
    let systemPrompt = ''
    const unified: { role: string; content: string; toolCalls?: any[]; toolResults?: any[] }[] = []
    const pendingToolResults: any[] = []

    for (const m of req.messages) {
        if (m.role === 'system') {
            systemPrompt += extractText(m.content) + '\n'
            continue
        }
        if (m.role === 'tool') {
            pendingToolResults.push({
                content: [{ text: extractText(m.content) || '(empty result)' }],
                status: 'success',
                toolUseId: m.tool_call_id ?? '',
            })
            continue
        }
        if (pendingToolResults.length) {
            unified.push({ role: 'user', content: '', toolResults: [...pendingToolResults] })
            pendingToolResults.length = 0
        }
        const entry: (typeof unified)[0] = { role: m.role, content: extractText(m.content) }
        if (m.role === 'assistant' && m.tool_calls?.length) {
            entry.toolCalls = m.tool_calls.map((tc: any) => ({
                name: tc.function?.name ?? '',
                input: JSON.parse(tc.function?.arguments ?? '{}'),
                toolUseId: tc.id ?? '',
            }))
        }
        unified.push(entry)
    }
    if (pendingToolResults.length) {
        unified.push({ role: 'user', content: '', toolResults: [...pendingToolResults] })
    }

    systemPrompt = systemPrompt.trim()

    // Merge adjacent same-role messages
    const merged: typeof unified = []
    for (const m of unified) {
        const last = merged[merged.length - 1]
        if (last && last.role === m.role) {
            last.content = (last.content + '\n' + m.content).trim()
            if (m.toolCalls) last.toolCalls = [...(last.toolCalls ?? []), ...m.toolCalls]
            if (m.toolResults) last.toolResults = [...(last.toolResults ?? []), ...m.toolResults]
        } else {
            merged.push({ ...m })
        }
    }

    // Ensure first message is user
    if (merged.length && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: '(empty)' })
    }

    // Ensure alternating roles
    const alternated: typeof merged = [merged[0]]
    for (let i = 1; i < merged.length; i++) {
        if (merged[i].role === alternated[alternated.length - 1].role) {
            alternated.push({ role: merged[i].role === 'user' ? 'assistant' : 'user', content: '(empty)' })
        }
        alternated.push(merged[i])
    }

    const modelId = req.model ?? 'claude-sonnet-4.5'
    const historyMsgs = alternated.length > 1 ? alternated.slice(0, -1) : []
    const current = alternated[alternated.length - 1]

    // Prepend system prompt to first user message in history (or current if no history)
    if (systemPrompt) {
        if (historyMsgs.length && historyMsgs[0].role === 'user') {
            historyMsgs[0].content = systemPrompt + '\n\n' + historyMsgs[0].content
        } else {
            current.content = systemPrompt + '\n\n' + current.content
        }
    }

    // Build history array
    const history: any[] = historyMsgs.map((m) => {
        if (m.role === 'user') {
            const ui: any = { content: m.content || '(empty)', modelId, origin: 'AI_EDITOR' }
            if (m.toolResults?.length) {
                ui.userInputMessageContext = { toolResults: m.toolResults }
            }
            return { userInputMessage: ui }
        }
        const ar: any = { content: m.content || '(empty)' }
        if (m.toolCalls?.length) ar.toolUses = m.toolCalls
        return { assistantResponseMessage: ar }
    })

    // Current message
    let currentContent = current.content || '(empty)'
    if (current.role === 'assistant') {
        history.push({ assistantResponseMessage: { content: currentContent } })
        currentContent = 'Continue'
    }

    const userInput: any = { content: currentContent, modelId, origin: 'AI_EDITOR' }
    const ctx: any = {}

    // Tools
    if (req.tools?.length) {
        ctx.tools = req.tools
            .filter((t) => t.type === 'function' && t.function)
            .map((t) => ({
                toolSpecification: {
                    name: t.function!.name,
                    description: t.function!.description || `Tool: ${t.function!.name}`,
                    inputSchema: { json: sanitizeSchema(t.function!.parameters ?? {}) },
                },
            }))
    }

    // Tool results on current message
    if (current.toolResults?.length) {
        ctx.toolResults = current.toolResults
    }

    if (Object.keys(ctx).length) userInput.userInputMessageContext = ctx

    const payload: any = {
        conversationState: {
            chatTriggerType: 'MANUAL',
            conversationId,
            currentMessage: { userInputMessage: userInput },
        },
    }
    if (history.length) payload.conversationState.history = history
    if (profileArn) payload.profileArn = profileArn

    return payload
}

// ── AWS SSE stream parser ────────────────────────────────────────────────────

interface ParsedEvent {
    type: 'content' | 'tool_start' | 'tool_input' | 'tool_stop' | 'usage' | 'context_usage'
    data: any
}

function findMatchingBrace(text: string, start: number): number {
    if (start >= text.length || text[start] !== '{') return -1
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
        const c = text[i]
        if (esc) { esc = false; continue }
        if (c === '\\' && inStr) { esc = true; continue }
        if (c === '"') { inStr = !inStr; continue }
        if (!inStr) {
            if (c === '{') depth++
            else if (c === '}' && --depth === 0) return i
        }
    }
    return -1
}

const EVENT_PATTERNS: [string, ParsedEvent['type']][] = [
    ['{"content":', 'content'],
    ['{"name":', 'tool_start'],
    ['{"input":', 'tool_input'],
    ['{"stop":', 'tool_stop'],
    ['{"usage":', 'usage'],
    ['{"contextUsagePercentage":', 'context_usage'],
]

function parseChunk(buffer: { value: string }): ParsedEvent[] {
    const events: ParsedEvent[] = []
    while (true) {
        let earliest = -1
        let eType: ParsedEvent['type'] | undefined
        for (const [pat, t] of EVENT_PATTERNS) {
            const pos = buffer.value.indexOf(pat)
            if (pos !== -1 && (earliest === -1 || pos < earliest)) {
                earliest = pos
                eType = t
            }
        }
        if (earliest === -1 || !eType) break
        const end = findMatchingBrace(buffer.value, earliest)
        if (end === -1) break
        const json = buffer.value.slice(earliest, end + 1)
        buffer.value = buffer.value.slice(end + 1)
        try {
            const data = JSON.parse(json)
            events.push({ type: eType, data })
        } catch { /* skip malformed */ }
    }
    return events
}

// ── HTTP request to CodeWhisperer API ────────────────────────────────────────

function postStream(url: string, body: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url)
        const opts: https.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname,
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }
        const req = https.request(opts, (res) => resolve(res))
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

async function streamFromCW(payload: any): Promise<http.IncomingMessage> {
    const token = await AuthUtil.instance.getBearerToken()
    const clientConfig = AuthUtil.instance.regionProfileManager.clientConfig as { endpoint: string; region: string }
    const url = `${clientConfig.endpoint}/generateAssistantResponse`
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'x-amzn-codewhisperer-optout': 'false',
    }
    return postStream(url, JSON.stringify(payload), headers)
}

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

    // Helper: store the completed assistant turn in the session so follow-up
    // requests in stateful mode have the full history available.
    const persistAssistantTurn = (content: string, calls: any[]) => {
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: content || null }
        if (calls.length) assistantMsg.tool_calls = calls.map(({ _index: _i, ...rest }) => rest)
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

        const message: any = { role: 'assistant', content: fullContent }
        if (toolCalls.length) message.tool_calls = toolCalls
        const finishReason = toolCalls.length ? 'tool_calls' : 'stop'

        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Session-Id': sessionId })
        res.end(JSON.stringify({
            id: requestId, object: 'chat.completion', created, model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        }))
    }
}

// Token-based context window sizes (chars / 4 ≈ tokens)
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
    'amazon-q':          160_000,
    'claude-sonnet-4.6': 200_000,
    'claude-sonnet-4.5': 200_000,
    'claude-sonnet-4':   200_000,
    'claude-haiku-4.5':  260_000,
}

async function handleModels(res: http.ServerResponse) {
    const created = Math.floor(Date.now() / 1000)

    // Try to fetch the live model list from the backend so the response matches
    // what the plugin UI shows. Fall back to the hardcoded list if the user is
    // not authenticated or the API call fails.
    if (AuthUtil.instance.isConnected()) {
        try {
            const profileArn = AuthUtil.instance.regionProfileManager?.activeRegionProfile?.arn
            const response = await codeWhispererClient.listAvailableModels({
                origin: 'AI_EDITOR',
                ...(profileArn ? { profileArn } : {}),
            })
            const data = response.models.map((m: { modelId: string; modelName?: string; description?: string; tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number } }) => {
                const modelId = m.modelId
                // Use token limits from the API when available, otherwise fall back
                // to the hardcoded map so context-window info is always present.
                const contextTokens = m.tokenLimits?.maxInputTokens ?? MODEL_CONTEXT_TOKENS[modelId] ?? 160_000
                return {
                    id: modelId,
                    object: 'model',
                    created,
                    owned_by: 'amazon',
                    name: m.modelName ?? modelId,
                    description: m.description,
                    context_length: contextTokens,
                    context_window: contextTokens,
                }
            })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ object: 'list', data }))
            return
        } catch (err) {
            log.warn('openaiServer: listAvailableModels API call failed, falling back to static list: %s', err)
        }
    }

    // Fallback: return the hardcoded list
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
        object: 'list',
        data: Object.entries(MODEL_CONTEXT_TOKENS).map(([id, ctx]) => ({
            id,
            object: 'model',
            created,
            owned_by: 'amazon',
            context_length: ctx,
            context_window: ctx,
        })),
    }))
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
        req.on('error', reject)
    })
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

        this.server = http.createServer(async (req, res) => {
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
            this.server!.listen(this._port, '127.0.0.1', () => {
                log.info('OpenAI-compatible server listening on http://127.0.0.1:%d', this._port)
                resolve()
            })
            this.server!.on('error', (err) => { this.server = undefined; reject(err) })
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
    <p class="hint">Requires a restart to take effect.</p>
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
                    void vscode.window.showInformationMessage(
                        `Settings saved. Port: ${newPort}. ${serverInstance?.isRunning ? 'Restart the server to apply the new port.' : ''}`
                    )
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
