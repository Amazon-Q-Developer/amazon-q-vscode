/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared format converters for the Anthropic-compatible gateway server.
 * Converts between Anthropic API format and the internal OpenAI-compatible
 * format used by buildKiroPayload().
 */

import { randomUUID } from 'crypto'
import { OpenAIMessage, OpenAITool, extractText, sanitizeSchema } from './serverUtils'

// ── Anthropic content block types ─────────────────────────────────────────────

export interface AnthropicContentBlock {
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

export interface AnthropicMessage {
    role: 'user' | 'assistant' | 'system'
    content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
    name: string
    description?: string
    input_schema: any
    type?: string
}

// ── Anthropic → OpenAI converters ─────────────────────────────────────────────

/**
 * Convert Anthropic content blocks to a plain text string + tool_calls array
 * that the shared buildKiroPayload() understands.
 */
export function anthropicContentToOpenAI(content: string | AnthropicContentBlock[]): {
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
            const resultText =
                typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                            .filter((b: any) => b.type === 'text')
                            .map((b: any) => b.text ?? '')
                            .join('')
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

    return {
        text,
        tool_calls: tool_calls.length ? tool_calls : undefined,
        tool_results: tool_results.length ? tool_results : undefined,
    }
}

/**
 * Convert an array of Anthropic messages to the OpenAI message format
 * that buildKiroPayload() expects.
 */
export function anthropicMessagesToOpenAI(messages: AnthropicMessage[], systemPrompt?: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = []

    if (systemPrompt) {
        result.push({ role: 'system', content: systemPrompt })
    }

    for (const m of messages) {
        if (m.role === 'system') {
            // mid-conversation system blocks — treat as system message
            result.push({
                role: 'system',
                content: typeof m.content === 'string' ? m.content : extractText(m.content),
            })
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
export function anthropicToolsToOpenAI(tools: AnthropicTool[]): OpenAITool[] {
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
export function extractSystemPrompt(system?: string | Array<{ type: string; text: string }>): string {
    if (!system) return ''
    if (typeof system === 'string') return system
    return system
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
}
