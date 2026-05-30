/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import {
    anthropicContentToOpenAI,
    anthropicMessagesToOpenAI,
    anthropicToolsToOpenAI,
    extractSystemPrompt,
    AnthropicContentBlock,
    AnthropicMessage,
    AnthropicTool,
} from '../../../src/gatewayFormatConverters'

// ── extractSystemPrompt ───────────────────────────────────────────────────────

describe('extractSystemPrompt', () => {
    it('returns empty string for undefined', () => {
        assert.strictEqual(extractSystemPrompt(undefined), '')
    })

    it('returns string as-is', () => {
        assert.strictEqual(extractSystemPrompt('You are a helpful assistant.'), 'You are a helpful assistant.')
    })

    it('joins text blocks from array', () => {
        const system = [
            { type: 'text', text: 'You are helpful.' },
            { type: 'text', text: 'Be concise.' },
        ]
        assert.strictEqual(extractSystemPrompt(system), 'You are helpful.\nBe concise.')
    })

    it('filters out non-text blocks', () => {
        const system = [
            { type: 'text', text: 'Only this.' },
            { type: 'cache_control', text: 'ignored' },
        ]
        assert.strictEqual(extractSystemPrompt(system), 'Only this.')
    })

    it('returns empty string for empty array', () => {
        assert.strictEqual(extractSystemPrompt([]), '')
    })
})

// ── anthropicContentToOpenAI ──────────────────────────────────────────────────

describe('anthropicContentToOpenAI', () => {
    it('returns text for string content', () => {
        const result = anthropicContentToOpenAI('hello world')
        assert.deepStrictEqual(result, { text: 'hello world' })
    })

    it('extracts text from text blocks', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.text, 'Hello world')
        assert.strictEqual(result.tool_calls, undefined)
    })

    it('skips thinking blocks', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'thinking', thinking: 'internal thought' },
            { type: 'text', text: 'visible text' },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.text, 'visible text')
    })

    it('skips redacted_thinking blocks', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'redacted_thinking', data: 'redacted' },
            { type: 'text', text: 'visible' },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.text, 'visible')
    })

    it('converts tool_use blocks to tool_calls', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'tool_use',
                id: 'toolu_abc',
                name: 'search',
                input: { query: 'test' },
            },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.ok(result.tool_calls)
        assert.strictEqual(result.tool_calls.length, 1)
        assert.strictEqual(result.tool_calls[0].id, 'toolu_abc')
        assert.strictEqual(result.tool_calls[0].type, 'function')
        assert.strictEqual(result.tool_calls[0].function.name, 'search')
        assert.strictEqual(result.tool_calls[0].function.arguments, '{"query":"test"}')
    })

    it('handles tool_use with string input', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'tool_use', id: 'toolu_str', name: 'tool', input: '{"raw":"json"}' },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.tool_calls![0].function.arguments, '{"raw":"json"}')
    })

    it('generates UUID for tool_use without id', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'tool_use', name: 'tool', input: {} },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.ok(result.tool_calls![0].id)
        assert.ok(result.tool_calls![0].id.length > 0)
    })

    it('converts tool_result blocks to tool_results', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'search result text' },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.ok(result.tool_results)
        assert.strictEqual(result.tool_results.length, 1)
        assert.strictEqual(result.tool_results[0].tool_call_id, 'toolu_abc')
        assert.strictEqual(result.tool_results[0].content, 'search result text')
    })

    it('extracts text from tool_result content array', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'tool_result',
                tool_use_id: 'toolu_xyz',
                content: [
                    { type: 'text', text: 'part1 ' },
                    { type: 'text', text: 'part2' },
                ],
            },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.tool_results![0].content, 'part1 part2')
    })

    it('replaces image blocks with placeholder', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'image', source: { type: 'base64', data: 'abc' } },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.text, '[image]')
    })

    it('extracts text from document blocks', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'document', source: { type: 'text', data: 'document content' } },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.text, 'document content')
    })

    it('replaces base64 document with placeholder', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'document', source: { type: 'base64', data: 'abc' } },
        ]
        const result = anthropicContentToOpenAI(blocks)
        assert.strictEqual(result.text, '[document]')
    })

    it('returns undefined for tool_calls when none present', () => {
        const result = anthropicContentToOpenAI([{ type: 'text', text: 'hi' }])
        assert.strictEqual(result.tool_calls, undefined)
        assert.strictEqual(result.tool_results, undefined)
    })
})

// ── anthropicMessagesToOpenAI ─────────────────────────────────────────────────

describe('anthropicMessagesToOpenAI', () => {
    it('prepends system message when systemPrompt provided', () => {
        const messages: AnthropicMessage[] = [{ role: 'user', content: 'hello' }]
        const result = anthropicMessagesToOpenAI(messages, 'You are helpful.')
        assert.strictEqual(result[0].role, 'system')
        assert.strictEqual(result[0].content, 'You are helpful.')
        assert.strictEqual(result[1].role, 'user')
    })

    it('converts user message with string content', () => {
        const messages: AnthropicMessage[] = [{ role: 'user', content: 'hello' }]
        const result = anthropicMessagesToOpenAI(messages)
        assert.strictEqual(result.length, 1)
        assert.strictEqual(result[0].role, 'user')
        assert.strictEqual(result[0].content, 'hello')
    })

    it('converts assistant message with text blocks', () => {
        const messages: AnthropicMessage[] = [
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'I can help with that.' }],
            },
        ]
        const result = anthropicMessagesToOpenAI(messages)
        assert.strictEqual(result[0].role, 'assistant')
        assert.strictEqual(result[0].content, 'I can help with that.')
    })

    it('converts assistant message with tool_use to tool_calls', () => {
        const messages: AnthropicMessage[] = [
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me search.' },
                    { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'test' } },
                ],
            },
        ]
        const result = anthropicMessagesToOpenAI(messages)
        assert.strictEqual(result[0].role, 'assistant')
        assert.strictEqual(result[0].content, 'Let me search.')
        assert.ok(result[0].tool_calls)
        assert.strictEqual(result[0].tool_calls![0].id, 'toolu_1')
    })

    it('converts user message with tool_result to separate tool messages', () => {
        const messages: AnthropicMessage[] = [
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'search results' },
                ],
            },
        ]
        const result = anthropicMessagesToOpenAI(messages)
        assert.strictEqual(result[0].role, 'tool')
        assert.strictEqual(result[0].content, 'search results')
        assert.strictEqual(result[0].tool_call_id, 'toolu_1')
    })

    it('handles user message with tool_result and additional text', () => {
        const messages: AnthropicMessage[] = [
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
                    { type: 'text', text: 'What do you think?' },
                ],
            },
        ]
        const result = anthropicMessagesToOpenAI(messages)
        assert.strictEqual(result[0].role, 'tool')
        assert.strictEqual(result[1].role, 'user')
        assert.strictEqual(result[1].content, 'What do you think?')
    })

    it('handles mid-conversation system messages', () => {
        const messages: AnthropicMessage[] = [
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'New instructions.' },
            { role: 'user', content: 'continue' },
        ]
        const result = anthropicMessagesToOpenAI(messages)
        assert.strictEqual(result[1].role, 'system')
        assert.strictEqual(result[1].content, 'New instructions.')
    })

    it('handles full conversation with multiple turns', () => {
        const messages: AnthropicMessage[] = [
            { role: 'user', content: 'What is 2+2?' },
            { role: 'assistant', content: [{ type: 'text', text: '4' }] },
            { role: 'user', content: 'And 3+3?' },
        ]
        const result = anthropicMessagesToOpenAI(messages, 'You are a math tutor.')
        assert.strictEqual(result.length, 4) // system + 3 messages
        assert.strictEqual(result[0].role, 'system')
        assert.strictEqual(result[1].role, 'user')
        assert.strictEqual(result[2].role, 'assistant')
        assert.strictEqual(result[3].role, 'user')
    })
})

// ── anthropicToolsToOpenAI ────────────────────────────────────────────────────

describe('anthropicToolsToOpenAI', () => {
    it('converts a basic tool', () => {
        const tools: AnthropicTool[] = [
            {
                name: 'search',
                description: 'Search the web',
                input_schema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            },
        ]
        const result = anthropicToolsToOpenAI(tools)
        assert.strictEqual(result.length, 1)
        assert.strictEqual(result[0].type, 'function')
        assert.strictEqual(result[0].function!.name, 'search')
        assert.strictEqual(result[0].function!.description, 'Search the web')
        assert.ok(result[0].function!.parameters)
    })

    it('filters out non-custom tool types', () => {
        const tools: AnthropicTool[] = [
            { name: 'computer', type: 'computer_20241022', input_schema: {} },
            { name: 'bash', type: 'bash_20241022', input_schema: {} },
            { name: 'custom_tool', type: 'custom', input_schema: {} },
            { name: 'no_type_tool', input_schema: {} },
        ]
        const result = anthropicToolsToOpenAI(tools)
        assert.strictEqual(result.length, 2)
        assert.strictEqual(result[0].function!.name, 'custom_tool')
        assert.strictEqual(result[1].function!.name, 'no_type_tool')
    })

    it('handles empty tools array', () => {
        const result = anthropicToolsToOpenAI([])
        assert.deepStrictEqual(result, [])
    })

    it('handles tool without description', () => {
        const tools: AnthropicTool[] = [
            { name: 'no_desc', input_schema: { type: 'object', properties: {} } },
        ]
        const result = anthropicToolsToOpenAI(tools)
        assert.strictEqual(result[0].function!.description, undefined)
    })
})
