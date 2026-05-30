/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Core gateway functionality shared between OpenAI and Anthropic compatible servers.
 * Extracts common session management, stream parsing, and error handling logic.
 */

import * as http from 'http'
import { randomUUID } from 'crypto'
import {
    log,
    OpenAIMessage,
    OpenAITool,
    OpenAIChatRequest,
    sessionStore,
    convStateMap,
    trimMessages,
    buildKiroPayload,
    streamFromCW,
    parseChunk,
    extractText,
    ParsedEvent,
} from './serverUtils'

// ── Core Gateway Types ────────────────────────────────────────────────────────

export interface GatewayRequest {
    model: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    stream?: boolean
    max_tokens?: number
    systemPrompt?: string
}

export interface GatewaySession {
    id: string
    messages: OpenAIMessage[]
    model: string
    tools?: OpenAITool[]
    convState: { contextUsagePct: number; summary?: string }
}

export interface GatewayToolCall {
    id: string
    name: string
    input: any
    _rawArgs: string
    _blockIndex?: number
}

export interface GatewayStreamState {
    buffer: { value: string }
    toolCalls: GatewayToolCall[]
    currentTool: GatewayToolCall | null
    lastContent: string | null
    promptTokens: number
    completionTokens: number
    streamedContent: string
}

export interface GatewayResponse {
    content: string
    toolCalls: GatewayToolCall[]
    promptTokens: number
    completionTokens: number
}

// ── Session Management ────────────────────────────────────────────────────────

export class GatewaySessionManager {
    /**
     * Create or retrieve a session based on incoming session ID.
     * Returns session ID and effective messages (merged if stateful).
     */
    static manageSession(
        incomingSessionId: string | undefined,
        messages: OpenAIMessage[],
        model: string,
        tools?: OpenAITool[]
    ): { sessionId: string; effectiveMessages: OpenAIMessage[] } {
        if (incomingSessionId) {
            const session = sessionStore.get(incomingSessionId)
            if (!session) {
                throw new GatewayError(400, 'invalid_request_error', `Unknown session ID: ${incomingSessionId}. Start a new conversation without X-Session-Id.`)
            }
            const merged = sessionStore.append(incomingSessionId, messages, tools)
            if (!merged) {
                throw new GatewayError(400, 'invalid_request_error', 'Failed to append to session')
            }
            return { sessionId: incomingSessionId, effectiveMessages: merged }
        } else {
            const sessionId = sessionStore.create(messages, model, tools)
            return { sessionId, effectiveMessages: messages }
        }
    }

    /**
     * Handle context compression when usage exceeds threshold.
     */
    static handleContextCompression(
        sessionKey: string,
        sessionId: string,
        messages: OpenAIMessage[]
    ): void {
        const prevState = convStateMap.get(sessionKey) ?? sessionStore.get(sessionId)?.convState
        if (prevState?.contextUsagePct !== undefined && prevState.contextUsagePct >= 90) {
            log.warn('Gateway: context at %d%% — compressing history for session %s', prevState.contextUsagePct, sessionId)
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
            prevState.summary = lastAssistant
                ? `Last assistant response: ${extractText(lastAssistant.content).slice(0, 2000)}`
                : 'Context was compressed due to length.'
            prevState.contextUsagePct = 0
        }
    }

    /**
     * Update context usage percentage from upstream events.
     */
    static updateContextUsage(
        sessionKey: string,
        sessionId: string,
        contextUsagePercentage: number
    ): void {
        const state = convStateMap.get(sessionKey) ?? { contextUsagePct: 0 }
        state.contextUsagePct = contextUsagePercentage
        convStateMap.set(sessionKey, state)
        sessionStore.updateConvState(sessionId, { contextUsagePct: contextUsagePercentage })
        
        if (contextUsagePercentage >= 75) {
            log.warn('Gateway: context pressure %d%% — approaching limit (session=%s)', contextUsagePercentage, sessionId)
        }
    }
}

// ── Stream Processing ─────────────────────────────────────────────────────────

export class GatewayStreamProcessor {
    /**
     * Initialize a new stream processing state.
     */
    static createState(): GatewayStreamState {
        return {
            buffer: { value: '' },
            toolCalls: [],
            currentTool: null,
            lastContent: null,
            promptTokens: 0,
            completionTokens: 0,
            streamedContent: '',
        }
    }

    /**
     * Process a stream event and update state.
     */
    static processEvent(
        event: ParsedEvent,
        state: GatewayStreamState,
        sessionKey?: string,
        sessionId?: string
    ): { type: 'content' | 'tool' | 'meta'; data?: any } | null {
        switch (event.type) {
            case 'content': {
                const text = event.data.content ?? ''
                if (text === state.lastContent) return null
                state.lastContent = text
                state.streamedContent += text
                return { type: 'content', data: text }
            }

            case 'tool_start': {
                if (state.currentTool) state.toolCalls.push(state.currentTool)
                const toolId = event.data.toolUseId ?? `tool_${randomUUID().slice(0, 8)}`
                const initialInput = typeof event.data.input === 'object' ? event.data.input : {}
                state.currentTool = {
                    id: toolId,
                    name: event.data.name ?? '',
                    input: initialInput,
                    _rawArgs: typeof event.data.input === 'object' ? JSON.stringify(event.data.input) : (event.data.input ?? ''),
                }
                if (event.data.stop) {
                    state.toolCalls.push(state.currentTool)
                    state.currentTool = null
                }
                return { type: 'tool', data: { action: 'start', tool: state.currentTool } }
            }

            case 'tool_input': {
                if (!state.currentTool) return null
                const inp = typeof event.data.input === 'object' ? JSON.stringify(event.data.input) : (event.data.input ?? '')
                if (inp) {
                    state.currentTool._rawArgs += inp
                    if (typeof event.data.input === 'object') {
                        Object.assign(state.currentTool.input, event.data.input)
                    }
                }
                return { type: 'tool', data: { action: 'input', input: inp } }
            }

            case 'tool_stop': {
                if (!state.currentTool) return null
                try {
                    state.currentTool.input = JSON.parse(state.currentTool._rawArgs)
                } catch {
                    // Keep partial JSON
                }
                state.toolCalls.push(state.currentTool)
                const finishedTool = state.currentTool
                state.currentTool = null
                return { type: 'tool', data: { action: 'stop', tool: finishedTool } }
            }

            case 'usage': {
                state.promptTokens = event.data.inputTokens ?? event.data.inputTokenCount ?? state.promptTokens
                state.completionTokens = event.data.outputTokens ?? event.data.outputTokenCount ?? state.completionTokens
                return { type: 'meta', data: { type: 'usage', prompt: state.promptTokens, completion: state.completionTokens } }
            }

            case 'context_usage': {
                const pct: number = event.data.contextUsagePercentage ?? 0
                if (sessionKey && sessionId) {
                    GatewaySessionManager.updateContextUsage(sessionKey, sessionId, pct)
                }
                return { type: 'meta', data: { type: 'context_usage', percentage: pct } }
            }

            default:
                return null
        }
    }

    /**
     * Finalize tool calls after stream ends.
     */
    static finalizeToolCalls(state: GatewayStreamState): GatewayToolCall[] {
        if (state.currentTool) {
            try {
                state.currentTool.input = JSON.parse(state.currentTool._rawArgs)
            } catch {
                // Keep partial JSON
            }
            state.toolCalls.push(state.currentTool)
            state.currentTool = null
        }

        // Deduplicate tool calls by ID, keeping the most complete
        const seen = new Map<string, GatewayToolCall>()
        for (const tc of state.toolCalls) {
            const existing = seen.get(tc.id)
            if (!existing || JSON.stringify(tc.input).length > JSON.stringify(existing.input).length) {
                seen.set(tc.id, tc)
            }
        }
        return [...seen.values()]
    }

    /**
     * Process complete stream and return final response.
     */
    static async processStream(
        upstream: http.IncomingMessage,
        sessionKey?: string,
        sessionId?: string
    ): Promise<GatewayResponse> {
        const state = GatewayStreamProcessor.createState()
        
        for await (const raw of upstream) {
            state.buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(state.buffer)) {
                GatewayStreamProcessor.processEvent(ev, state, sessionKey, sessionId)
            }
        }

        const dedupedToolCalls = GatewayStreamProcessor.finalizeToolCalls(state)
        
        return {
            content: state.streamedContent,
            toolCalls: dedupedToolCalls,
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
        }
    }
}

// ── Request Processing ────────────────────────────────────────────────────────

export class GatewayRequestProcessor {
    /**
     * Prepare and execute a request to the CodeWhisperer backend.
     */
    static async executeRequest(
        request: GatewayRequest,
        sessionId: string,
        sessionKey: string
    ): Promise<{ upstream: http.IncomingMessage; trimmedMessages: OpenAIMessage[] }> {
        const { model, messages, tools, max_tokens } = request
        
        // Get previous state and trim messages
        const prevState = convStateMap.get(sessionKey) ?? sessionStore.get(sessionId)?.convState
        const trimmedMessages = trimMessages(messages, model, prevState)
        
        // Build payload
        const conversationId = randomUUID()
        const oaiReq: OpenAIChatRequest = {
            model,
            messages: trimmedMessages,
            tools,
            stream: request.stream,
            max_tokens,
        }
        
        const payload = buildKiroPayload(oaiReq, conversationId, undefined)
        if (max_tokens) {
            payload.conversationState.currentMessage.userInputMessage.maxTokens = max_tokens
        }
        
        // Execute request
        const upstream = await streamFromCW(payload)
        if (upstream.statusCode !== 200) {
            const chunks: Buffer[] = []
            for await (const c of upstream) chunks.push(c as Buffer)
            const body = Buffer.concat(chunks).toString()
            throw new GatewayError(upstream.statusCode ?? 502, 'api_error', `Upstream ${upstream.statusCode}: ${body}`)
        }
        
        return { upstream, trimmedMessages }
    }

    /**
     * Persist assistant turn to session store.
     */
    static persistAssistantTurn(
        sessionId: string,
        content: string,
        toolCalls: GatewayToolCall[]
    ): void {
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: content || null }
        if (toolCalls.length) {
            assistantMsg.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
        }
        sessionStore.append(sessionId, [assistantMsg])
    }
}

// ── Error Handling ────────────────────────────────────────────────────────────

export class GatewayError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly type: string,
        message: string
    ) {
        super(message)
        this.name = 'GatewayError'
    }

    toOpenAIFormat(): any {
        return {
            error: {
                message: this.message,
                type: this.type,
                code: this.statusCode.toString(),
            }
        }
    }

    toAnthropicFormat(): any {
        return {
            type: 'error',
            error: {
                type: this.type,
                message: this.message,
            }
        }
    }
}

// ── Response Builders ─────────────────────────────────────────────────────────

export class GatewayResponseBuilder {
    /**
     * Build OpenAI-compatible response.
     */
    static buildOpenAIResponse(
        requestId: string,
        model: string,
        content: string,
        toolCalls: GatewayToolCall[],
        promptTokens: number,
        completionTokens: number,
        stream: boolean = false
    ): any {
        const created = Math.floor(Date.now() / 1000)
        const finishReason = toolCalls.length ? 'tool_calls' : 'stop'
        
        if (stream) {
            // Streaming response is built incrementally
            return {
                id: requestId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: null,
                }],
            }
        }
        
        const message: any = { role: 'assistant', content }
        if (toolCalls.length) {
            message.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
        }
        
        return {
            id: requestId,
            object: 'chat.completion',
            created,
            model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
            },
        }
    }

    /**
     * Build Anthropic-compatible response.
     */
    static buildAnthropicResponse(
        messageId: string,
        model: string,
        content: string,
        toolCalls: GatewayToolCall[],
        promptTokens: number,
        completionTokens: number
    ): any {
        const contentBlocks: any[] = []
        if (content) contentBlocks.push({ type: 'text', text: content })
        for (const tc of toolCalls) {
            contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
        }
        
        const stopReason = toolCalls.length ? 'tool_use' : 'end_turn'
        
        return {
            id: messageId,
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
}