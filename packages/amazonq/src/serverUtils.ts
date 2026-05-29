/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared utilities for the OpenAI-compatible and Anthropic-compatible local
 * API servers.  Both servers proxy to Amazon Q's generateAssistantResponse
 * streaming API and share the same session management, context trimming, and
 * stream-parsing logic.
 */

import * as http from 'http'
import * as https from 'https'
import { AuthUtil, codeWhispererClient } from 'aws-core-vscode/codewhisperer'
import { getLogger } from 'aws-core-vscode/shared'
import { randomUUID } from 'crypto'

export const log = getLogger()

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpenAIMessage {
    role: string
    content: any
    tool_calls?: any[]
    tool_call_id?: string
}

export interface OpenAITool {
    type: string
    function?: { name: string; description?: string; parameters?: any }
}

export interface OpenAIChatRequest {
    model?: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    stream?: boolean
    max_tokens?: number
}

// ── Context window limits per model (chars, ~4 chars/token) ──────────────────

export const MODEL_CONTEXT_CHARS: Record<string, number> = {
    'amazon-q':          640_000,   // ~160k tokens
    'claude-sonnet-4.6': 800_000,   // ~200k tokens
    'claude-sonnet-4.5': 800_000,
    'claude-sonnet-4':   800_000,
    'claude-haiku-4.5':  1_040_000, // ~260k tokens
}
export const DEFAULT_CONTEXT_CHARS = 640_000
// Reserve ~20% for the response
export const HISTORY_BUDGET_RATIO = 0.8

// Token-based context window sizes (chars / 4 ≈ tokens)
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
    'amazon-q':          160_000,
    'claude-sonnet-4.6': 200_000,
    'claude-sonnet-4.5': 200_000,
    'claude-sonnet-4':   200_000,
    'claude-haiku-4.5':  260_000,
}

// ── Per-conversation context pressure tracker ─────────────────────────────────

export interface ConvState {
    /** Last contextUsagePercentage received from upstream (0-100) */
    contextUsagePct: number
    /** Summary injected when context was compressed */
    summary?: string
}

// ── Server-side session store ─────────────────────────────────────────────────

export interface Session {
    messages: OpenAIMessage[]
    model: string
    tools?: OpenAITool[]
    convState: ConvState
    lastUsed: number
}

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

export class SessionStore {
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

export const sessionStore = new SessionStore()
export const convStateMap = new Map<string, ConvState>()

// ── History trimming (sliding window) ────────────────────────────────────────

/**
 * Trims the message list to fit within the model's context budget.
 * System messages are always kept. Non-system messages are dropped oldest-first
 * until the total character count fits within the budget.
 */
export function trimMessages(messages: OpenAIMessage[], model: string, convState?: ConvState): OpenAIMessage[] {
    const budgetChars = Math.floor((MODEL_CONTEXT_CHARS[model] ?? DEFAULT_CONTEXT_CHARS) * HISTORY_BUDGET_RATIO)

    const systemMsgs = messages.filter((m) => m.role === 'system')
    const nonSystem = messages.filter((m) => m.role !== 'system')

    const extraSystem: OpenAIMessage[] = convState?.summary
        ? [{ role: 'system', content: `[Previous conversation summary]\n${convState.summary}` }]
        : []

    let used = [...systemMsgs, ...extraSystem].reduce((n, m) => n + extractText(m.content).length, 0)
    const kept: OpenAIMessage[] = []

    for (let i = nonSystem.length - 1; i >= 0; i--) {
        const len = extractText(nonSystem[i].content).length
        if (used + len > budgetChars) {
            log.debug('serverUtils: dropping message %d (role=%s, len=%d) — budget exhausted', i, nonSystem[i].role, len)
            break
        }
        kept.unshift(nonSystem[i])
        used += len
    }

    while (kept.length && kept[0].role !== 'user') {
        log.debug('serverUtils: dropping leading %s message to restore user-first invariant', kept[0].role)
        kept.shift()
    }
    while (kept.length && kept[0].role === 'tool') {
        log.debug('serverUtils: dropping leading tool-result message (no preceding tool_call)')
        kept.shift()
    }

    const dropped = nonSystem.length - kept.length
    if (dropped > 0) {
        log.warn('serverUtils: trimmed %d messages to fit %d-char budget (model=%s)', dropped, budgetChars, model)
    }

    return [...systemMsgs, ...extraSystem, ...kept]
}

// ── Session key (stable ID for a logical conversation) ───────────────────────

export function buildSessionKey(messages: OpenAIMessage[]): string {
    const system = messages.find((m) => m.role === 'system')
    const firstUser = messages.find((m) => m.role === 'user')
    const raw = extractText(system?.content ?? '') + '|' + extractText(firstUser?.content ?? '').slice(0, 200)
    let h = 5381
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i)
    return (h >>> 0).toString(16)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function extractText(content: any): string {
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

export function sanitizeSchema(schema: any): any {
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

export function buildKiroPayload(req: OpenAIChatRequest, conversationId: string, profileArn?: string) {
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
                input: JSON.parse(tc.function?.arguments || '{}'),
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

    if (merged.length && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: '(empty)' })
    }

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

    if (systemPrompt) {
        if (historyMsgs.length && historyMsgs[0].role === 'user') {
            historyMsgs[0].content = systemPrompt + '\n\n' + historyMsgs[0].content
        } else {
            current.content = systemPrompt + '\n\n' + current.content
        }
    }

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

    let currentContent = current.content || '(empty)'
    if (current.role === 'assistant') {
        history.push({ assistantResponseMessage: { content: currentContent } })
        currentContent = 'Continue'
    }

    const userInput: any = { content: currentContent, modelId, origin: 'AI_EDITOR' }
    const ctx: any = {}

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

export interface ParsedEvent {
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

export function parseChunk(buffer: { value: string }): ParsedEvent[] {
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

export async function streamFromCW(payload: any): Promise<http.IncomingMessage> {
    const token = await AuthUtil.instance.getBearerToken()
    const clientConfig = AuthUtil.instance.regionProfileManager.clientConfig as { endpoint: string; region: string }
    const url = `${clientConfig.endpoint}/generateAssistantResponse`
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'x-amzn-codewhisperer-optout': 'false',
    }
    return postStream(url, JSON.stringify(payload), headers)
}

// ── Models helper ─────────────────────────────────────────────────────────────

export async function fetchModelList(): Promise<Array<{ modelId: string; modelName?: string; description?: string; contextTokens: number }>> {
    if (AuthUtil.instance.isConnected()) {
        try {
            const profileArn = AuthUtil.instance.regionProfileManager?.activeRegionProfile?.arn
            const response = await codeWhispererClient.listAvailableModels({
                origin: 'AI_EDITOR',
                ...(profileArn ? { profileArn } : {}),
            })
            return response.models.map((m: { modelId: string; modelName?: string; description?: string; tokenLimits?: { maxInputTokens?: number } }) => ({
                modelId: m.modelId,
                modelName: m.modelName,
                description: m.description,
                contextTokens: m.tokenLimits?.maxInputTokens ?? MODEL_CONTEXT_TOKENS[m.modelId] ?? 160_000,
            }))
        } catch (err) {
            log.warn('serverUtils: listAvailableModels failed, using static list: %s', err)
        }
    }
    return Object.entries(MODEL_CONTEXT_TOKENS).map(([modelId, contextTokens]) => ({ modelId, contextTokens }))
}

// ── Body reader ───────────────────────────────────────────────────────────────

export function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
        req.on('error', reject)
    })
}

// ── Multipart body reader (for Files API) ─────────────────────────────────────

export interface MultipartFile {
    fieldName: string
    filename: string
    contentType: string
    data: Buffer
}

export function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; files: MultipartFile[] } {
    const fields: Record<string, string> = {}
    const files: MultipartFile[] = []
    const sep = Buffer.from(`--${boundary}`)
    const parts: Buffer[] = []

    let start = 0
    while (start < body.length) {
        const idx = body.indexOf(sep, start)
        if (idx === -1) break
        const partStart = idx + sep.length
        if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break // --boundary--
        // skip \r\n after boundary
        const headerStart = partStart + 2
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart)
        if (headerEnd === -1) { start = partStart; continue }
        const headerStr = body.slice(headerStart, headerEnd).toString()
        const dataStart = headerEnd + 4
        const nextBoundary = body.indexOf(sep, dataStart)
        const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2 // strip \r\n before boundary
        const data = body.slice(dataStart, dataEnd)
        parts.push(data)

        const dispMatch = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/)
        const fileMatch = headerStr.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/)
        const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/)
        const fieldName = dispMatch?.[1] ?? ''

        if (fileMatch) {
            files.push({ fieldName, filename: fileMatch[1], contentType: ctMatch?.[1]?.trim() ?? 'application/octet-stream', data })
        } else {
            fields[fieldName] = data.toString()
        }
        start = nextBoundary === -1 ? body.length : nextBoundary
    }
    return { fields, files }
}
