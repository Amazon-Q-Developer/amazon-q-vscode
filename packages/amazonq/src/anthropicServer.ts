/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Anthropic-compatible API server that proxies to Amazon Q / CodeWhisperer.
 * Implements the full Anthropic Messages API surface:
 *   POST   /v1/messages                  — create a message (streaming + non-streaming)
 *   POST   /v1/messages/count_tokens     — count tokens (best-effort estimation)
 *   POST   /v1/messages/batches          — async batch processing (in-process fan-out)
 *   GET    /v1/messages/batches          — list batches
 *   GET    /v1/messages/batches/:id      — get batch status
 *   GET    /v1/messages/batches/:id/results — stream batch results
 *   POST   /v1/messages/batches/:id/cancel  — cancel a batch
 *   DELETE /v1/messages/batches/:id      — delete a batch
 *   GET    /v1/models                    — list models (Anthropic format)
 *   GET    /v1/models/:id                — get a single model
 *   POST   /v1/files                     — upload a file
 *   GET    /v1/files                     — list files
 *   GET    /v1/files/:id                 — get file metadata
 *   DELETE /v1/files/:id                 — delete a file
 *   GET    /v1/files/:id/content         — download file content
 *   POST   /v1/skills                    — create a skill (local registry)
 *   GET    /v1/skills                    — list skills
 *   GET    /v1/skills/:id                — get a skill
 *   PUT    /v1/skills/:id                — update a skill
 *   DELETE /v1/skills/:id                — delete a skill
 *   POST   /v1/agents                    — create an agent (local registry)
 *   GET    /v1/agents                    — list agents
 *   GET    /v1/agents/:id                — get an agent
 *   PUT    /v1/agents/:id                — update an agent
 *   DELETE /v1/agents/:id                — delete an agent
 *   POST   /v1/sessions                  — create a session (Docker or stub)
 *   GET    /v1/sessions                  — list sessions
 *   GET    /v1/sessions/:id              — get session status
 *   GET    /v1/sessions/:id/stream       — stream session events
 *   DELETE /v1/sessions/:id              — stop/delete a session
 *   POST   /v1/environments              — create an environment config
 *   GET    /v1/environments              — list environments
 *   GET    /v1/environments/:id          — get an environment
 *   PUT    /v1/environments/:id          — update an environment
 *   DELETE /v1/environments/:id          — delete an environment
 */

import * as http from 'http'
import * as vscode from 'vscode'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
    log,
    OpenAIMessage,
    OpenAITool,
    OpenAIChatRequest,
    sessionStore,
    convStateMap,
    trimMessages,
    buildSessionKey,
    buildKiroPayload,
    streamFromCW,
    parseChunk,
    extractText,
    sanitizeSchema,
    fetchModelList,
    readBody,
    parseMultipart,
} from './serverUtils'

const execFileAsync = promisify(execFile)

// ── Anthropic request types ───────────────────────────────────────────────────

interface AnthropicContentBlock {
    type: string
    text?: string
    source?: any
    id?: string
    name?: string
    input?: any
    tool_use_id?: string
    content?: any
    thinking?: string
    signature?: string
    data?: string
}

interface AnthropicMessage {
    role: 'user' | 'assistant' | 'system'
    content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
    name: string
    description?: string
    input_schema: any
    type?: string
}

interface AnthropicMessagesRequest {
    model: string
    messages: AnthropicMessage[]
    max_tokens: number
    system?: string | Array<{ type: string; text: string; cache_control?: any }>
    tools?: AnthropicTool[]
    tool_choice?: any
    stream?: boolean
    temperature?: number
    top_p?: number
    top_k?: number
    stop_sequences?: string[]
    thinking?: any
    metadata?: any
}

// ── In-memory stores ──────────────────────────────────────────────────────────

interface StoredFile {
    id: string
    filename: string
    purpose: string
    content_type: string
    size: number
    data: Buffer
    created_at: number
}

interface BatchRequest {
    custom_id: string
    params: AnthropicMessagesRequest
}

interface BatchResult {
    custom_id: string
    result: { type: 'succeeded'; message: any } | { type: 'errored'; error: any } | { type: 'canceled' }
}

interface StoredBatch {
    id: string
    created_at: number
    expires_at: number
    status: 'in_progress' | 'ended' | 'canceling' | 'canceled'
    request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number }
    results: BatchResult[]
    cancel_requested: boolean
}

interface StoredSkill {
    id: string
    name: string
    description?: string
    input_schema: any
    created_at: number
    updated_at: number
}

interface StoredAgent {
    id: string
    name: string
    description?: string
    model: string
    system_prompt?: string
    skill_ids: string[]
    created_at: number
    updated_at: number
}

interface StoredEnvironment {
    id: string
    name: string
    image: string
    memory_mb: number
    created_at: number
    updated_at: number
}

interface StoredSession {
    id: string
    agent_id?: string
    environment_id?: string
    status: 'created' | 'running' | 'stopped' | 'error'
    container_id?: string
    created_at: number
    messages: OpenAIMessage[]
    tools: OpenAITool[]
    sseClients: http.ServerResponse[]
}

const fileStore = new Map<string, StoredFile>()
const batchStore = new Map<string, StoredBatch>()
const skillStore = new Map<string, StoredSkill>()
const agentStore = new Map<string, StoredAgent>()
const environmentStore = new Map<string, StoredEnvironment>()
const sessionMap = new Map<string, StoredSession>()

// ── Anthropic ↔ OpenAI format converters ─────────────────────────────────────

/**
 * Convert Anthropic content blocks to a plain text string + tool_calls array
 * that the shared buildKiroPayload() understands.
 */
function anthropicContentToOpenAI(content: string | AnthropicContentBlock[]): {
    text: string
    tool_calls?: any[]
    tool_results?: Array<{ tool_call_id: string; content: string }>
} {
    if (typeof content === 'string') return { text: content }

    let text = ''
    const tool_calls: any[] = []
    const tool_results: Array<{ tool_call_id: string; content: string }> = []

    for (const block of content) {
        if (block.type === 'text') {
            text += block.text ?? ''
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // thinking blocks are internal — skip for upstream payload
        } else if (block.type === 'tool_use') {
            tool_calls.push({
                id: block.id ?? randomUUID(),
                type: 'function',
                function: {
                    name: block.name ?? '',
                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
                },
            })
        } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('')
                    : ''
            tool_results.push({ tool_call_id: block.tool_use_id ?? '', content: resultText })
        } else if (block.type === 'image') {
            // Images: include a placeholder text so context isn't lost
            text += '[image]'
        } else if (block.type === 'document') {
            // Documents: extract text if available
            const src = block.source
            if (src?.type === 'text' && src.data) text += src.data
            else if (src?.type === 'base64') text += '[document]'
        }
    }

    return { text, tool_calls: tool_calls.length ? tool_calls : undefined, tool_results: tool_results.length ? tool_results : undefined }
}

/**
 * Convert an array of Anthropic messages to the OpenAI message format
 * that buildKiroPayload() expects.
 */
function anthropicMessagesToOpenAI(
    messages: AnthropicMessage[],
    systemPrompt?: string
): OpenAIMessage[] {
    const result: OpenAIMessage[] = []

    if (systemPrompt) {
        result.push({ role: 'system', content: systemPrompt })
    }

    for (const m of messages) {
        if (m.role === 'system') {
            // mid-conversation system blocks — treat as system message
            result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : extractText(m.content) })
            continue
        }

        const { text, tool_calls, tool_results } = anthropicContentToOpenAI(m.content)

        if (m.role === 'user') {
            if (tool_results?.length) {
                // tool_result blocks inside a user message → separate tool messages
                for (const tr of tool_results) {
                    result.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_call_id })
                }
                if (text) result.push({ role: 'user', content: text })
            } else {
                result.push({ role: 'user', content: text })
            }
        } else if (m.role === 'assistant') {
            const msg: OpenAIMessage = { role: 'assistant', content: text }
            if (tool_calls?.length) msg.tool_calls = tool_calls
            result.push(msg)
        }
    }

    return result
}

/** Convert Anthropic tools to OpenAI tool format */
function anthropicToolsToOpenAI(tools: AnthropicTool[]): OpenAITool[] {
    return tools
        .filter((t) => !t.type || t.type === 'custom')
        .map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: sanitizeSchema(t.input_schema ?? {}),
            },
        }))
}

/** Extract system prompt string from Anthropic system field */
function extractSystemPrompt(system?: string | Array<{ type: string; text: string }>): string {
    if (!system) return ''
    if (typeof system === 'string') return system
    return system.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function anthropicError(res: http.ServerResponse, status: number, type: string, message: string) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

function notSupported(res: http.ServerResponse, feature: string) {
    anthropicError(res, 501, 'not_supported_error',
        `${feature} requires Docker. Enable it in Amazon Q settings (amazonQ.anthropicServer.dockerEnabled) and ensure Docker is running.`)
}

// ── Core: execute one Anthropic messages request, return Anthropic Message ────

/**
 * Execute a single AnthropicMessagesRequest against the Amazon Q backend.
 * Returns the full Anthropic Message object (non-streaming).
 * Used by both handleMessages() and the batch processor.
 */
async function executeMessages(req: AnthropicMessagesRequest): Promise<any> {
    const model = req.model ?? 'claude-sonnet-4.5'
    const systemPrompt = extractSystemPrompt(req.system)
    const openaiMessages = anthropicMessagesToOpenAI(req.messages, systemPrompt)
    const openaiTools = req.tools?.length ? anthropicToolsToOpenAI(req.tools) : undefined

    const oaiReq: OpenAIChatRequest = {
        model,
        messages: openaiMessages,
        tools: openaiTools,
        stream: false,
        max_tokens: req.max_tokens,
    }

    const sessionId = sessionStore.create(openaiMessages, model, openaiTools)
    const sessionKey = buildSessionKey(openaiMessages)
    const prevState = convStateMap.get(sessionKey) ?? sessionStore.get(sessionId)?.convState
    const trimmed = trimMessages(openaiMessages, model, prevState)
    oaiReq.messages = trimmed

    const conversationId = randomUUID()
    let profileArn: string | undefined
    try { profileArn = AuthUtil.instance.regionProfileManager?.activeRegionProfile?.arn } catch { /* optional */ }

    const payload = buildKiroPayload(oaiReq, conversationId, profileArn)
    if (req.max_tokens) payload.conversationState.currentMessage.userInputMessage.maxTokens = req.max_tokens

    const upstream = await streamFromCW(payload)
    if (upstream.statusCode !== 200) {
        const chunks: Buffer[] = []
        for await (const c of upstream) chunks.push(c as Buffer)
        throw new Error(`Upstream ${upstream.statusCode}: ${Buffer.concat(chunks).toString()}`)
    }

    const buffer = { value: '' }
    const toolCalls: any[] = []
    let currentTool: any = null
    let fullContent = ''
    let lastContent: string | null = null
    let promptTokens = 0
    let completionTokens = 0

    for await (const raw of upstream) {
        buffer.value += (raw as Buffer).toString('utf-8')
        for (const ev of parseChunk(buffer)) {
            if (ev.type === 'content') {
                const text = ev.data.content ?? ''
                if (text !== lastContent) { fullContent += text; lastContent = text }
            } else if (ev.type === 'tool_start') {
                if (currentTool) toolCalls.push(currentTool)
                currentTool = {
                    id: ev.data.toolUseId ?? `toolu_${randomUUID().slice(0, 8)}`,
                    name: ev.data.name ?? '',
                    input: typeof ev.data.input === 'object' ? ev.data.input : {},
                    _rawArgs: typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? ''),
                }
                if (ev.data.stop) { toolCalls.push(currentTool); currentTool = null }
            } else if (ev.type === 'tool_input' && currentTool) {
                if (typeof ev.data.input === 'object') {
                    Object.assign(currentTool.input, ev.data.input)
                } else {
                    currentTool._rawArgs += ev.data.input ?? ''
                }
            } else if (ev.type === 'tool_stop' && currentTool) {
                try { currentTool.input = JSON.parse(currentTool._rawArgs) } catch { /* keep partial */ }
                toolCalls.push(currentTool); currentTool = null
            } else if (ev.type === 'usage') {
                promptTokens = ev.data.inputTokens ?? ev.data.inputTokenCount ?? promptTokens
                completionTokens = ev.data.outputTokens ?? ev.data.outputTokenCount ?? completionTokens
            } else if (ev.type === 'context_usage') {
                const pct: number = ev.data.contextUsagePercentage ?? 0
                const state = convStateMap.get(sessionKey) ?? { contextUsagePct: 0 }
                state.contextUsagePct = pct
                convStateMap.set(sessionKey, state)
                sessionStore.updateConvState(sessionId, { contextUsagePct: pct })
            }
        }
    }
    if (currentTool) {
        try { currentTool.input = JSON.parse(currentTool._rawArgs) } catch {}
        toolCalls.push(currentTool)
    }

    // Deduplicate tool calls
    const seen = new Map<string, any>()
    for (const tc of toolCalls) {
        const existing = seen.get(tc.id)
        if (!existing || JSON.stringify(tc.input).length > JSON.stringify(existing.input).length) seen.set(tc.id, tc)
    }
    const dedupedTools = [...seen.values()]

    // Build Anthropic content blocks
    const contentBlocks: any[] = []
    if (fullContent) contentBlocks.push({ type: 'text', text: fullContent })
    for (const tc of dedupedTools) {
        contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    }

    const stopReason = dedupedTools.length ? 'tool_use' : 'end_turn'
    const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

    return {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: contentBlocks,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
    }
}

// ── POST /v1/messages ─────────────────────────────────────────────────────────

async function handleMessages(req: AnthropicMessagesRequest, res: http.ServerResponse, incomingHeaders: http.IncomingHttpHeaders) {
    const model = req.model ?? 'claude-sonnet-4.5'
    const systemPrompt = extractSystemPrompt(req.system)
    const openaiMessages = anthropicMessagesToOpenAI(req.messages, systemPrompt)
    const openaiTools = req.tools?.length ? anthropicToolsToOpenAI(req.tools) : undefined

    // Session management (same pattern as OpenAI server)
    const incomingSessionId = incomingHeaders['x-session-id'] as string | undefined
    let sessionId: string
    let effectiveMessages: OpenAIMessage[]

    if (incomingSessionId) {
        const session = sessionStore.get(incomingSessionId)
        if (!session) {
            anthropicError(res, 400, 'invalid_request_error', `Unknown session ID: ${incomingSessionId}. Start a new conversation without X-Session-Id.`)
            return
        }
        const merged = sessionStore.append(incomingSessionId, openaiMessages, openaiTools)!
        effectiveMessages = merged
        sessionId = incomingSessionId
    } else {
        sessionId = sessionStore.create(openaiMessages, model, openaiTools)
        effectiveMessages = openaiMessages
    }

    const sessionKey = buildSessionKey(effectiveMessages)
    const prevState = convStateMap.get(sessionKey) ?? sessionStore.get(sessionId)?.convState
    if (prevState?.contextUsagePct !== undefined && prevState.contextUsagePct >= 90) {
        const lastAssistant = [...effectiveMessages].reverse().find((m) => m.role === 'assistant')
        prevState.summary = lastAssistant
            ? `Last assistant response: ${extractText(lastAssistant.content).slice(0, 2000)}`
            : 'Context was compressed due to length.'
        prevState.contextUsagePct = 0
    }

    const trimmed = trimMessages(effectiveMessages, model, prevState)
    const oaiReq: OpenAIChatRequest = { model, messages: trimmed, tools: openaiTools, stream: req.stream, max_tokens: req.max_tokens }

    const conversationId = randomUUID()
    const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

    let profileArn: string | undefined
    try { profileArn = AuthUtil.instance.regionProfileManager?.activeRegionProfile?.arn } catch {}

    const payload = buildKiroPayload(oaiReq, conversationId, profileArn)
    if (req.max_tokens) payload.conversationState.currentMessage.userInputMessage.maxTokens = req.max_tokens

    let upstream: http.IncomingMessage
    try {
        upstream = await streamFromCW(payload)
    } catch (err: any) {
        log.error('anthropicServer: CW request failed: %s', err)
        anthropicError(res, 502, 'api_error', `Upstream error: ${err.message}`)
        return
    }

    if (upstream.statusCode !== 200) {
        const chunks: Buffer[] = []
        for await (const c of upstream) chunks.push(c as Buffer)
        anthropicError(res, upstream.statusCode ?? 502, 'api_error', `Upstream ${upstream.statusCode}: ${Buffer.concat(chunks).toString()}`)
        return
    }

    const buffer = { value: '' }
    const toolCalls: any[] = []
    let currentTool: any = null
    let lastContent: string | null = null
    let promptTokens = 0
    let completionTokens = 0

    const handleMetaEvent = (ev: any) => {
        if (ev.type === 'usage') {
            promptTokens = ev.data.inputTokens ?? ev.data.inputTokenCount ?? promptTokens
            completionTokens = ev.data.outputTokens ?? ev.data.outputTokenCount ?? completionTokens
        } else if (ev.type === 'context_usage') {
            const pct: number = ev.data.contextUsagePercentage ?? 0
            const state = convStateMap.get(sessionKey) ?? { contextUsagePct: 0 }
            state.contextUsagePct = pct
            convStateMap.set(sessionKey, state)
            sessionStore.updateConvState(sessionId, { contextUsagePct: pct })
        }
    }

    if (req.stream) {
        // ── Streaming: Anthropic SSE format ──────────────────────────────────
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Session-Id': sessionId,
            'anthropic-version': '2023-06-01',
        })

        const sendEvent = (event: string, data: any) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        // message_start
        sendEvent('message_start', {
            type: 'message_start',
            message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 } },
        })

        let blockIndex = 0
        let textBlockOpen = false
        let streamedContent = ''

        for await (const raw of upstream) {
            buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(buffer)) {
                if (ev.type === 'content') {
                    const text = ev.data.content ?? ''
                    if (text === lastContent) continue
                    lastContent = text
                    streamedContent += text
                    if (!textBlockOpen) {
                        sendEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })
                        textBlockOpen = true
                    }
                    sendEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } })
                } else if (ev.type === 'tool_start') {
                    if (textBlockOpen) {
                        sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
                        blockIndex++
                        textBlockOpen = false
                    }
                    if (currentTool) toolCalls.push(currentTool)
                    const toolId = ev.data.toolUseId ?? `toolu_${randomUUID().slice(0, 8)}`
                    const initialInput = typeof ev.data.input === 'object' ? ev.data.input : {}
                    currentTool = { id: toolId, name: ev.data.name ?? '', input: initialInput, _rawArgs: typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? ''), _blockIndex: blockIndex }
                    sendEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: toolId, name: ev.data.name ?? '', input: {} } })
                    if (currentTool._rawArgs) {
                        sendEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: currentTool._rawArgs } })
                    }
                    if (ev.data.stop) {
                        sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
                        blockIndex++
                        toolCalls.push(currentTool); currentTool = null
                    }
                } else if (ev.type === 'tool_input' && currentTool) {
                    const inp = typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '')
                    if (inp) {
                        currentTool._rawArgs += inp
                        sendEvent('content_block_delta', { type: 'content_block_delta', index: currentTool._blockIndex, delta: { type: 'input_json_delta', partial_json: inp } })
                    }
                } else if (ev.type === 'tool_stop' && currentTool) {
                    try { currentTool.input = JSON.parse(currentTool._rawArgs) } catch {}
                    sendEvent('content_block_stop', { type: 'content_block_stop', index: currentTool._blockIndex })
                    blockIndex++
                    toolCalls.push(currentTool); currentTool = null
                } else {
                    handleMetaEvent(ev)
                }
            }
        }

        if (currentTool) {
            try { currentTool.input = JSON.parse(currentTool._rawArgs) } catch {}
            sendEvent('content_block_stop', { type: 'content_block_stop', index: currentTool._blockIndex })
            toolCalls.push(currentTool)
        }
        if (textBlockOpen) {
            sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
        }

        const stopReason = toolCalls.length ? 'tool_use' : 'end_turn'
        sendEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: completionTokens },
        })
        sendEvent('message_stop', { type: 'message_stop' })
        res.end()

        // Persist assistant turn
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: streamedContent || null }
        if (toolCalls.length) {
            assistantMsg.tool_calls = toolCalls.map((tc) => ({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
        }
        sessionStore.append(sessionId, [assistantMsg])
    } else {
        // ── Non-streaming ─────────────────────────────────────────────────────
        let fullContent = ''
        for await (const raw of upstream) {
            buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(buffer)) {
                if (ev.type === 'content') {
                    const text = ev.data.content ?? ''
                    if (text !== lastContent) { fullContent += text; lastContent = text }
                } else if (ev.type === 'tool_start') {
                    if (currentTool) toolCalls.push(currentTool)
                    currentTool = {
                        id: ev.data.toolUseId ?? `toolu_${randomUUID().slice(0, 8)}`,
                        name: ev.data.name ?? '',
                        input: typeof ev.data.input === 'object' ? ev.data.input : {},
                        _rawArgs: typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? ''),
                    }
                    if (ev.data.stop) { toolCalls.push(currentTool); currentTool = null }
                } else if (ev.type === 'tool_input' && currentTool) {
                    if (typeof ev.data.input === 'object') Object.assign(currentTool.input, ev.data.input)
                    else currentTool._rawArgs += ev.data.input ?? ''
                } else if (ev.type === 'tool_stop' && currentTool) {
                    try { currentTool.input = JSON.parse(currentTool._rawArgs) } catch {}
                    toolCalls.push(currentTool); currentTool = null
                } else { handleMetaEvent(ev) }
            }
        }
        if (currentTool) {
            try { currentTool.input = JSON.parse(currentTool._rawArgs) } catch {}
            toolCalls.push(currentTool)
        }

        // Deduplicate
        const seen = new Map<string, any>()
        for (const tc of toolCalls) {
            const ex = seen.get(tc.id)
            if (!ex || JSON.stringify(tc.input).length > JSON.stringify(ex.input).length) seen.set(tc.id, tc)
        }
        const deduped = [...seen.values()]

        const contentBlocks: any[] = []
        if (fullContent) contentBlocks.push({ type: 'text', text: fullContent })
        for (const tc of deduped) contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })

        const stopReason = deduped.length ? 'tool_use' : 'end_turn'

        // Persist assistant turn
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: fullContent || null }
        if (deduped.length) {
            assistantMsg.tool_calls = deduped.map((tc) => ({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
        }
        sessionStore.append(sessionId, [assistantMsg])

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-Session-Id': sessionId,
            'anthropic-version': '2023-06-01',
            'request-id': randomUUID(),
        })
        res.end(JSON.stringify({
            id: msgId, type: 'message', role: 'assistant', content: contentBlocks, model,
            stop_reason: stopReason, stop_sequence: null,
            usage: { input_tokens: promptTokens, output_tokens: completionTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }))
    }
}

// ── POST /v1/messages/count_tokens ────────────────────────────────────────────

function handleCountTokens(req: AnthropicMessagesRequest, res: http.ServerResponse) {
    // Best-effort estimation: ~4 chars per token
    const systemPrompt = extractSystemPrompt(req.system)
    const openaiMessages = anthropicMessagesToOpenAI(req.messages, systemPrompt)
    let totalChars = systemPrompt.length
    for (const m of openaiMessages) totalChars += extractText(m.content).length
    const inputTokens = Math.ceil(totalChars / 4)
    res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
    res.end(JSON.stringify({ input_tokens: inputTokens }))
}

// ── Message Batches ───────────────────────────────────────────────────────────

function batchToResponse(b: StoredBatch) {
    return {
        id: b.id,
        type: 'message_batch',
        processing_status: b.status,
        request_counts: b.request_counts,
        ended_at: b.status === 'ended' || b.status === 'canceled' ? Math.floor(Date.now() / 1000) : null,
        created_at: b.created_at,
        expires_at: b.expires_at,
        cancel_initiated_at: b.cancel_requested ? Math.floor(Date.now() / 1000) : null,
        results_url: b.status === 'ended' ? `/v1/messages/batches/${b.id}/results` : null,
    }
}

async function processBatch(batchId: string, requests: BatchRequest[]) {
    const batch = batchStore.get(batchId)
    if (!batch) return

    for (const req of requests) {
        if (batch.cancel_requested) {
            batch.results.push({ custom_id: req.custom_id, result: { type: 'canceled' } })
            batch.request_counts.canceled++
            batch.request_counts.processing--
            continue
        }
        try {
            const message = await executeMessages(req.params)
            batch.results.push({ custom_id: req.custom_id, result: { type: 'succeeded', message } })
            batch.request_counts.succeeded++
        } catch (err: any) {
            batch.results.push({ custom_id: req.custom_id, result: { type: 'errored', error: { type: 'api_error', message: err.message } } })
            batch.request_counts.errored++
        }
        batch.request_counts.processing--
    }
    batch.status = batch.cancel_requested ? 'canceled' : 'ended'
}

function handleBatches(method: string, pathParts: string[], body: any, res: http.ServerResponse) {
    const batchId = pathParts[3] // /v1/messages/batches/:id
    const subAction = pathParts[4] // results | cancel

    if (method === 'POST' && !batchId) {
        // Create batch
        const requests: BatchRequest[] = body.requests ?? []
        if (!requests.length) { anthropicError(res, 400, 'invalid_request_error', 'requests array is required'); return }
        const id = `msgbatch_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const now = Math.floor(Date.now() / 1000)
        const batch: StoredBatch = {
            id, created_at: now, expires_at: now + 86400,
            status: 'in_progress',
            request_counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
            results: [], cancel_requested: false,
        }
        batchStore.set(id, batch)
        // Process asynchronously
        void processBatch(id, requests)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify(batchToResponse(batch)))
        return
    }

    if (method === 'GET' && !batchId) {
        // List batches
        const data = [...batchStore.values()].map(batchToResponse)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }))
        return
    }

    if (!batchId) { anthropicError(res, 404, 'not_found_error', 'Not found'); return }
    const batch = batchStore.get(batchId)
    if (!batch) { anthropicError(res, 404, 'not_found_error', `Batch ${batchId} not found`); return }

    if (method === 'GET' && !subAction) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify(batchToResponse(batch)))
        return
    }

    if (method === 'GET' && subAction === 'results') {
        res.writeHead(200, { 'Content-Type': 'application/x-jsonl', 'anthropic-version': '2023-06-01' })
        for (const r of batch.results) res.write(JSON.stringify(r) + '\n')
        res.end()
        return
    }

    if (method === 'POST' && subAction === 'cancel') {
        batch.cancel_requested = true
        if (batch.status === 'in_progress') batch.status = 'canceling'
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify(batchToResponse(batch)))
        return
    }

    if (method === 'DELETE' && !subAction) {
        batchStore.delete(batchId)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ id: batchId, deleted: true }))
        return
    }

    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Files API ─────────────────────────────────────────────────────────────────

function fileToMeta(f: StoredFile) {
    return { id: f.id, object: 'file', filename: f.filename, purpose: f.purpose, content_type: f.content_type, size: f.size, created_at: f.created_at }
}

async function handleFiles(method: string, pathParts: string[], req: http.IncomingMessage, res: http.ServerResponse) {
    const fileId = pathParts[2] // /v1/files/:id
    const subAction = pathParts[3] // content

    if (method === 'POST' && !fileId) {
        // Upload file — multipart/form-data
        const ct = req.headers['content-type'] ?? ''
        const boundaryMatch = ct.match(/boundary=([^\s;]+)/)
        if (!boundaryMatch) { anthropicError(res, 400, 'invalid_request_error', 'Expected multipart/form-data'); return }
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = Buffer.concat(chunks)
        const { fields, files } = parseMultipart(body, boundaryMatch[1])
        if (!files.length) { anthropicError(res, 400, 'invalid_request_error', 'No file in request'); return }
        const f = files[0]
        const id = `file_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const stored: StoredFile = {
            id, filename: f.filename, purpose: fields.purpose ?? 'assistants',
            content_type: f.contentType, size: f.data.length, data: f.data,
            created_at: Math.floor(Date.now() / 1000),
        }
        fileStore.set(id, stored)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify(fileToMeta(stored)))
        return
    }

    if (method === 'GET' && !fileId) {
        const data = [...fileStore.values()].map(fileToMeta)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ data, has_more: false }))
        return
    }

    if (!fileId) { anthropicError(res, 404, 'not_found_error', 'Not found'); return }
    const file = fileStore.get(fileId)
    if (!file) { anthropicError(res, 404, 'not_found_error', `File ${fileId} not found`); return }

    if (method === 'GET' && !subAction) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify(fileToMeta(file)))
        return
    }

    if (method === 'GET' && subAction === 'content') {
        res.writeHead(200, { 'Content-Type': file.content_type })
        res.end(file.data)
        return
    }

    if (method === 'DELETE' && !subAction) {
        fileStore.delete(fileId)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ id: fileId, deleted: true }))
        return
    }

    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Models API ────────────────────────────────────────────────────────────────

async function handleModels(method: string, pathParts: string[], res: http.ServerResponse) {
    const modelId = pathParts[2] // /v1/models/:id
    const created = Math.floor(Date.now() / 1000)
    const models = await fetchModelList()

    if (method === 'GET' && !modelId) {
        const data = models.map((m) => ({
            id: m.modelId, type: 'model', display_name: m.modelName ?? m.modelId,
            created_at: new Date(created * 1000).toISOString(),
        }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }))
        return
    }

    if (method === 'GET' && modelId) {
        const m = models.find((x) => x.modelId === modelId)
        if (!m) { anthropicError(res, 404, 'not_found_error', `Model ${modelId} not found`); return }
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ id: m.modelId, type: 'model', display_name: m.modelName ?? m.modelId, created_at: new Date(created * 1000).toISOString() }))
        return
    }

    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Skills API ────────────────────────────────────────────────────────────────

function handleSkills(method: string, pathParts: string[], body: any, res: http.ServerResponse) {
    const skillId = pathParts[2]
    const now = Math.floor(Date.now() / 1000)

    if (method === 'POST' && !skillId) {
        if (!body.name || !body.input_schema) { anthropicError(res, 400, 'invalid_request_error', 'name and input_schema required'); return }
        const id = `skill_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const skill: StoredSkill = { id, name: body.name, description: body.description, input_schema: body.input_schema, created_at: now, updated_at: now }
        skillStore.set(id, skill)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify(skill))
        return
    }
    if (method === 'GET' && !skillId) {
        const data = [...skillStore.values()]
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ data, has_more: false }))
        return
    }
    if (!skillId) { anthropicError(res, 404, 'not_found_error', 'Not found'); return }
    const skill = skillStore.get(skillId)
    if (!skill) { anthropicError(res, 404, 'not_found_error', `Skill ${skillId} not found`); return }
    if (method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(skill)); return }
    if (method === 'PUT') {
        Object.assign(skill, { name: body.name ?? skill.name, description: body.description ?? skill.description, input_schema: body.input_schema ?? skill.input_schema, updated_at: now })
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(skill)); return
    }
    if (method === 'DELETE') { skillStore.delete(skillId); res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify({ id: skillId, deleted: true })); return }
    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Agents API ────────────────────────────────────────────────────────────────

function handleAgents(method: string, pathParts: string[], body: any, res: http.ServerResponse) {
    const agentId = pathParts[2]
    const now = Math.floor(Date.now() / 1000)

    if (method === 'POST' && !agentId) {
        if (!body.name || !body.model) { anthropicError(res, 400, 'invalid_request_error', 'name and model required'); return }
        const id = `agent_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const agent: StoredAgent = { id, name: body.name, description: body.description, model: body.model, system_prompt: body.system_prompt, skill_ids: body.skill_ids ?? [], created_at: now, updated_at: now }
        agentStore.set(id, agent)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(agent)); return
    }
    if (method === 'GET' && !agentId) {
        const data = [...agentStore.values()]
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify({ data, has_more: false })); return
    }
    if (!agentId) { anthropicError(res, 404, 'not_found_error', 'Not found'); return }
    const agent = agentStore.get(agentId)
    if (!agent) { anthropicError(res, 404, 'not_found_error', `Agent ${agentId} not found`); return }
    if (method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(agent)); return }
    if (method === 'PUT') {
        Object.assign(agent, { name: body.name ?? agent.name, description: body.description ?? agent.description, model: body.model ?? agent.model, system_prompt: body.system_prompt ?? agent.system_prompt, skill_ids: body.skill_ids ?? agent.skill_ids, updated_at: now })
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(agent)); return
    }
    if (method === 'DELETE') { agentStore.delete(agentId); res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify({ id: agentId, deleted: true })); return }
    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Environments API ──────────────────────────────────────────────────────────

function handleEnvironments(method: string, pathParts: string[], body: any, res: http.ServerResponse) {
    const envId = pathParts[2]
    const now = Math.floor(Date.now() / 1000)

    if (method === 'POST' && !envId) {
        if (!body.name) { anthropicError(res, 400, 'invalid_request_error', 'name required'); return }
        const id = `env_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const env: StoredEnvironment = {
            id, name: body.name,
            image: body.image ?? vscode.workspace.getConfiguration('amazonQ').get<string>('anthropicServer.defaultEnvironmentImage', 'ubuntu:24.04'),
            memory_mb: body.memory_mb ?? vscode.workspace.getConfiguration('amazonQ').get<number>('anthropicServer.containerMemoryMb', 512),
            created_at: now, updated_at: now,
        }
        environmentStore.set(id, env)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(env)); return
    }
    if (method === 'GET' && !envId) {
        const data = [...environmentStore.values()]
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify({ data, has_more: false })); return
    }
    if (!envId) { anthropicError(res, 404, 'not_found_error', 'Not found'); return }
    const env = environmentStore.get(envId)
    if (!env) { anthropicError(res, 404, 'not_found_error', `Environment ${envId} not found`); return }
    if (method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(env)); return }
    if (method === 'PUT') {
        Object.assign(env, { name: body.name ?? env.name, image: body.image ?? env.image, memory_mb: body.memory_mb ?? env.memory_mb, updated_at: now })
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify(env)); return
    }
    if (method === 'DELETE') { environmentStore.delete(envId); res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify({ id: envId, deleted: true })); return }
    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Docker helpers ────────────────────────────────────────────────────────────

async function isDockerAvailable(): Promise<boolean> {
    try {
        await execFileAsync('docker', ['info'], { timeout: 5000 })
        return true
    } catch {
        return false
    }
}

async function startContainer(image: string, memoryMb: number, sessionId: string): Promise<string> {
    const { stdout } = await execFileAsync('docker', [
        'run', '-d', '--rm',
        `--memory=${memoryMb}m`,
        '--label', `anthropic-session=${sessionId}`,
        image,
        'sleep', 'infinity',
    ])
    return stdout.trim()
}

async function stopContainer(containerId: string): Promise<void> {
    try { await execFileAsync('docker', ['rm', '-f', containerId]) } catch { /* ignore */ }
}

/** Execute a shell command inside a running container. Reserved for future tool-execution support. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function execInContainer(containerId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const { stdout, stderr } = await execFileAsync('docker', ['exec', containerId, 'sh', '-c', command], { timeout: 30_000 })
        return { stdout, stderr, exitCode: 0 }
    } catch (err: any) {
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message, exitCode: err.code ?? 1 }
    }
}

// ── Sessions API ──────────────────────────────────────────────────────────────

async function handleSessions(method: string, pathParts: string[], body: any, req: http.IncomingMessage, res: http.ServerResponse) {
    const cfg = vscode.workspace.getConfiguration('amazonQ')
    const dockerEnabled = cfg.get<boolean>('anthropicServer.dockerEnabled', false)

    const sessionId = pathParts[2]
    const subAction = pathParts[3] // stream

    if (method === 'POST' && !sessionId) {
        if (!dockerEnabled) { notSupported(res, 'Sessions'); return }

        const agentId: string | undefined = body.agent_id
        const envId: string | undefined = body.environment_id
        const agent = agentId ? agentStore.get(agentId) : undefined
        const env = envId ? environmentStore.get(envId) : undefined

        const image = env?.image ?? cfg.get<string>('anthropicServer.defaultEnvironmentImage', 'ubuntu:24.04')
        const memoryMb = env?.memory_mb ?? cfg.get<number>('anthropicServer.containerMemoryMb', 512)

        if (!(await isDockerAvailable())) {
            anthropicError(res, 503, 'api_error', 'Docker is not available or not running.')
            return
        }

        const id = `sess_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const tools: OpenAITool[] = []

        // Inject skills from agent
        if (agent?.skill_ids?.length) {
            for (const sid of agent.skill_ids) {
                const skill = skillStore.get(sid)
                if (skill) tools.push({ type: 'function', function: { name: skill.name, description: skill.description, parameters: skill.input_schema } })
            }
        }

        const session: StoredSession = {
            id, agent_id: agentId, environment_id: envId,
            status: 'created', created_at: Math.floor(Date.now() / 1000),
            messages: agent?.system_prompt ? [{ role: 'system', content: agent.system_prompt }] : [],
            tools, sseClients: [],
        }
        sessionMap.set(id, session)

        try {
            const containerId = await startContainer(image, memoryMb, id)
            session.container_id = containerId
            session.status = 'running'
        } catch (err: any) {
            session.status = 'error'
            log.error('anthropicServer: failed to start container: %s', err)
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ id: session.id, status: session.status, agent_id: agentId, environment_id: envId, created_at: session.created_at }))
        return
    }

    if (method === 'GET' && !sessionId) {
        if (!dockerEnabled) { notSupported(res, 'Sessions'); return }
        const data = [...sessionMap.values()].map((s) => ({ id: s.id, status: s.status, agent_id: s.agent_id, environment_id: s.environment_id, created_at: s.created_at }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }); res.end(JSON.stringify({ data, has_more: false })); return
    }

    if (!sessionId) { anthropicError(res, 404, 'not_found_error', 'Not found'); return }

    if (!dockerEnabled) { notSupported(res, 'Sessions'); return }

    const session = sessionMap.get(sessionId)
    if (!session) { anthropicError(res, 404, 'not_found_error', `Session ${sessionId} not found`); return }

    if (method === 'GET' && !subAction) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ id: session.id, status: session.status, agent_id: session.agent_id, environment_id: session.environment_id, created_at: session.created_at }))
        return
    }

    if (method === 'GET' && subAction === 'stream') {
        // SSE stream for session events
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'anthropic-version': '2023-06-01' })
        session.sseClients.push(res)
        req.on('close', () => {
            session.sseClients = session.sseClients.filter((c) => c !== res)
        })
        // Send initial status
        res.write(`event: session_status\ndata: ${JSON.stringify({ type: 'session_status', status: session.status })}\n\n`)
        return
    }

    if (method === 'DELETE' && !subAction) {
        if (session.container_id) await stopContainer(session.container_id)
        session.status = 'stopped'
        for (const client of session.sseClients) {
            client.write(`event: session_status\ndata: ${JSON.stringify({ type: 'session_status', status: 'stopped' })}\n\n`)
            client.end()
        }
        sessionMap.delete(sessionId)
        res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' })
        res.end(JSON.stringify({ id: sessionId, deleted: true }))
        return
    }

    anthropicError(res, 404, 'not_found_error', 'Not found')
}

// ── Main HTTP server class ────────────────────────────────────────────────────

export class AnthropicCompatServer {
    private server: http.Server | undefined
    private _port: number

    constructor(port = 61823) { this._port = port }
    get port() { return this._port }
    get isRunning() { return !!this.server }

    async start(): Promise<void> {
        if (this.server) return

        const srv = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, X-Session-Id')
            res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id, anthropic-version, request-id')
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

            const url = new URL(req.url ?? '/', `http://127.0.0.1:${this._port}`)
            const pathname = url.pathname
            const method = req.method ?? 'GET'
            // Split path: ['', 'v1', 'messages', ...]
            const parts = pathname.split('/')

            try {
                // ── /v1/messages/count_tokens ─────────────────────────────────
                if (pathname === '/v1/messages/count_tokens' && method === 'POST') {
                    if (!AuthUtil.instance.isConnected()) { anthropicError(res, 401, 'authentication_error', 'Not authenticated with Amazon Q'); return }
                    const raw = await readBody(req)
                    let parsed: AnthropicMessagesRequest
                    try { parsed = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    handleCountTokens(parsed, res)
                    return
                }

                // ── /v1/messages/batches/* ────────────────────────────────────
                if (pathname.startsWith('/v1/messages/batches')) {
                    if (!AuthUtil.instance.isConnected()) { anthropicError(res, 401, 'authentication_error', 'Not authenticated with Amazon Q'); return }
                    let body: any = {}
                    if (method === 'POST') {
                        const raw = await readBody(req)
                        try { body = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    }
                    handleBatches(method, parts, body, res)
                    return
                }

                // ── /v1/messages ──────────────────────────────────────────────
                if (pathname === '/v1/messages' && method === 'POST') {
                    if (!AuthUtil.instance.isConnected()) { anthropicError(res, 401, 'authentication_error', 'Not authenticated with Amazon Q'); return }
                    const raw = await readBody(req)
                    let parsed: AnthropicMessagesRequest
                    try { parsed = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    if (!parsed.messages?.length) { anthropicError(res, 400, 'invalid_request_error', 'messages required'); return }
                    if (!parsed.max_tokens) { anthropicError(res, 400, 'invalid_request_error', 'max_tokens required'); return }
                    await handleMessages(parsed, res, req.headers)
                    return
                }

                // ── /v1/models/* ──────────────────────────────────────────────
                if (pathname.startsWith('/v1/models')) {
                    await handleModels(method, parts, res)
                    return
                }

                // ── /v1/files/* ───────────────────────────────────────────────
                if (pathname.startsWith('/v1/files')) {
                    await handleFiles(method, parts, req, res)
                    return
                }

                // ── /v1/skills/* ──────────────────────────────────────────────
                if (pathname.startsWith('/v1/skills')) {
                    let body: any = {}
                    if (method === 'POST' || method === 'PUT') {
                        const raw = await readBody(req)
                        try { body = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    }
                    handleSkills(method, parts, body, res)
                    return
                }

                // ── /v1/agents/* ──────────────────────────────────────────────
                if (pathname.startsWith('/v1/agents')) {
                    let body: any = {}
                    if (method === 'POST' || method === 'PUT') {
                        const raw = await readBody(req)
                        try { body = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    }
                    handleAgents(method, parts, body, res)
                    return
                }

                // ── /v1/environments/* ────────────────────────────────────────
                if (pathname.startsWith('/v1/environments')) {
                    let body: any = {}
                    if (method === 'POST' || method === 'PUT') {
                        const raw = await readBody(req)
                        try { body = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    }
                    handleEnvironments(method, parts, body, res)
                    return
                }

                // ── /v1/sessions/* ────────────────────────────────────────────
                if (pathname.startsWith('/v1/sessions')) {
                    let body: any = {}
                    if (method === 'POST') {
                        const raw = await readBody(req)
                        try { body = JSON.parse(raw) } catch { anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON'); return }
                    }
                    await handleSessions(method, parts, body, req, res)
                    return
                }

                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }))
            } catch (err: any) {
                log.error('anthropicServer: unhandled error: %s', err)
                if (!res.headersSent) anthropicError(res, 500, 'api_error', err.message ?? 'Internal error')
            }
        })

        return new Promise((resolve, reject) => {
            srv.listen(this._port, '127.0.0.1', () => {
                this.server = srv
                log.info('Anthropic-compatible server listening on http://127.0.0.1:%d', this._port)
                resolve()
            })
            srv.on('error', (err: NodeJS.ErrnoException) => {
                const detail = err.code === 'EADDRINUSE'
                    ? `Port ${this._port} is already in use. Change the port in Amazon Q settings (amazonQ.anthropicServer.port).`
                    : `${err.message} (code: ${err.code ?? 'unknown'})`
                log.error('Anthropic-compatible server failed to start: %s', detail)
                reject(new Error(detail))
            })
        })
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) { resolve(); return }
            // Stop all active Docker sessions
            for (const session of sessionMap.values()) {
                if (session.container_id) void stopContainer(session.container_id)
            }
            this.server.close(() => { this.server = undefined; log.info('Anthropic-compatible server stopped'); resolve() })
        })
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

let anthropicServerInstance: AnthropicCompatServer | undefined

export function activateAnthropicServer(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('amazonQ')
    const port = config.get<number>('anthropicServer.port', 61823)
    const autoStart = config.get<boolean>('anthropicServer.autoStart', true)

    anthropicServerInstance = new AnthropicCompatServer(port)

    context.subscriptions.push(
        vscode.commands.registerCommand('aws.amazonq.anthropicServer.start', async () => {
            try {
                await anthropicServerInstance!.start()
                void vscode.window.showInformationMessage(`Amazon Q Anthropic-compatible server on http://127.0.0.1:${anthropicServerInstance!.port}`)
            } catch (err: any) { void vscode.window.showErrorMessage(`Failed to start Anthropic server: ${err.message}`) }
        }),

        vscode.commands.registerCommand('aws.amazonq.anthropicServer.stop', async () => {
            await anthropicServerInstance!.stop()
            void vscode.window.showInformationMessage('Amazon Q Anthropic-compatible server stopped')
        }),

        { dispose: () => anthropicServerInstance?.stop() }
    )

    if (autoStart) {
        anthropicServerInstance.start().catch((err) => log.error('Anthropic server auto-start failed: %s', err))
    }
}
