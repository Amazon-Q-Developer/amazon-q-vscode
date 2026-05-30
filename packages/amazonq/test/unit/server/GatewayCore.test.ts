/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import {
    GatewayError,
    GatewaySessionManager,
    GatewayStreamProcessor,
    GatewayResponseBuilder,
    GatewayStreamState,
    GatewayToolCall,
} from '../../../src/GatewayCore'
import { sessionStore, convStateMap, ParsedEvent } from '../../../src/serverUtils'

// ── GatewayError ──────────────────────────────────────────────────────────────

describe('GatewayError', () => {
    it('stores statusCode, type, and message', () => {
        const err = new GatewayError(400, 'invalid_request_error', 'bad input')
        assert.strictEqual(err.statusCode, 400)
        assert.strictEqual(err.type, 'invalid_request_error')
        assert.strictEqual(err.message, 'bad input')
        assert.strictEqual(err.name, 'GatewayError')
    })

    it('toOpenAIFormat returns correct shape', () => {
        const err = new GatewayError(401, 'authentication_error', 'not authenticated')
        const fmt = err.toOpenAIFormat()
        assert.deepStrictEqual(fmt, {
            error: {
                message: 'not authenticated',
                type: 'authentication_error',
                code: '401',
            },
        })
    })

    it('toAnthropicFormat returns correct shape', () => {
        const err = new GatewayError(404, 'not_found_error', 'resource not found')
        const fmt = err.toAnthropicFormat()
        assert.deepStrictEqual(fmt, {
            type: 'error',
            error: {
                type: 'not_found_error',
                message: 'resource not found',
            },
        })
    })

    it('instanceof check works', () => {
        const err = new GatewayError(500, 'api_error', 'internal')
        assert.ok(err instanceof GatewayError)
        assert.ok(err instanceof Error)
    })
})

// ── GatewaySessionManager ─────────────────────────────────────────────────────

describe('GatewaySessionManager', () => {
    afterEach(() => {
        // Clean up convStateMap between tests
        convStateMap.clear()
    })

    describe('manageSession', () => {
        it('creates a new session when no incoming session ID', () => {
            const messages = [{ role: 'user', content: 'hello' }]
            const { sessionId, effectiveMessages } = GatewaySessionManager.manageSession(
                undefined,
                messages,
                'claude-sonnet-4.5'
            )
            assert.ok(sessionId)
            assert.deepStrictEqual(effectiveMessages, messages)
            // Session should be retrievable
            const session = sessionStore.get(sessionId)
            assert.ok(session)
            assert.strictEqual(session.model, 'claude-sonnet-4.5')
        })

        it('appends to existing session when session ID provided', () => {
            const initial = [{ role: 'user', content: 'first message' }]
            const { sessionId } = GatewaySessionManager.manageSession(undefined, initial, 'amazon-q')

            const followUp = [{ role: 'user', content: 'second message' }]
            const { sessionId: sid2, effectiveMessages } = GatewaySessionManager.manageSession(
                sessionId,
                followUp,
                'amazon-q'
            )

            assert.strictEqual(sid2, sessionId)
            assert.strictEqual(effectiveMessages.length, 2)
            assert.strictEqual(effectiveMessages[0].content, 'first message')
            assert.strictEqual(effectiveMessages[1].content, 'second message')
        })

        it('throws GatewayError for unknown session ID', () => {
            assert.throws(
                () => GatewaySessionManager.manageSession('nonexistent-id', [], 'amazon-q'),
                (err: any) => {
                    assert.ok(err instanceof GatewayError)
                    assert.strictEqual(err.statusCode, 400)
                    assert.strictEqual(err.type, 'invalid_request_error')
                    return true
                }
            )
        })

        it('stores tools in session', () => {
            const messages = [{ role: 'user', content: 'use a tool' }]
            const tools = [{ type: 'function', function: { name: 'my_tool', parameters: {} } }]
            const { sessionId } = GatewaySessionManager.manageSession(undefined, messages, 'amazon-q', tools)
            const session = sessionStore.get(sessionId)
            assert.deepStrictEqual(session?.tools, tools)
        })
    })

    describe('handleContextCompression', () => {
        it('does nothing when context usage is below threshold', () => {
            const { sessionId } = GatewaySessionManager.manageSession(
                undefined,
                [{ role: 'user', content: 'hi' }],
                'amazon-q'
            )
            const sessionKey = 'test-key-low'
            convStateMap.set(sessionKey, { contextUsagePct: 50 })

            GatewaySessionManager.handleContextCompression(sessionKey, sessionId, [
                { role: 'user', content: 'hi' },
            ])

            const state = convStateMap.get(sessionKey)
            assert.strictEqual(state?.contextUsagePct, 50) // unchanged
            assert.strictEqual(state?.summary, undefined)
        })

        it('compresses context when usage is at or above 90%', () => {
            const { sessionId } = GatewaySessionManager.manageSession(
                undefined,
                [{ role: 'user', content: 'hi' }],
                'amazon-q'
            )
            const sessionKey = 'test-key-high'
            convStateMap.set(sessionKey, { contextUsagePct: 90 })

            const messages = [
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'this is the last assistant response' },
            ]
            GatewaySessionManager.handleContextCompression(sessionKey, sessionId, messages)

            const state = convStateMap.get(sessionKey)
            assert.strictEqual(state?.contextUsagePct, 0) // reset
            assert.ok(state?.summary?.includes('this is the last assistant response'))
        })

        it('uses fallback summary when no assistant message exists', () => {
            const { sessionId } = GatewaySessionManager.manageSession(
                undefined,
                [{ role: 'user', content: 'hi' }],
                'amazon-q'
            )
            const sessionKey = 'test-key-no-assistant'
            convStateMap.set(sessionKey, { contextUsagePct: 95 })

            GatewaySessionManager.handleContextCompression(sessionKey, sessionId, [
                { role: 'user', content: 'only user message' },
            ])

            const state = convStateMap.get(sessionKey)
            assert.strictEqual(state?.contextUsagePct, 0)
            assert.ok(state?.summary?.includes('compressed'))
        })
    })

    describe('updateContextUsage', () => {
        it('updates convStateMap and sessionStore', () => {
            const { sessionId } = GatewaySessionManager.manageSession(
                undefined,
                [{ role: 'user', content: 'hi' }],
                'amazon-q'
            )
            const sessionKey = 'update-test-key'

            GatewaySessionManager.updateContextUsage(sessionKey, sessionId, 65)

            const mapState = convStateMap.get(sessionKey)
            assert.strictEqual(mapState?.contextUsagePct, 65)

            const session = sessionStore.get(sessionId)
            assert.strictEqual(session?.convState.contextUsagePct, 65)
        })
    })
})

// ── GatewayStreamProcessor ────────────────────────────────────────────────────

describe('GatewayStreamProcessor', () => {
    describe('createState', () => {
        it('returns a fresh state with correct defaults', () => {
            const state = GatewayStreamProcessor.createState()
            assert.deepStrictEqual(state.buffer, { value: '' })
            assert.deepStrictEqual(state.toolCalls, [])
            assert.strictEqual(state.currentTool, null)
            assert.strictEqual(state.lastContent, null)
            assert.strictEqual(state.promptTokens, 0)
            assert.strictEqual(state.completionTokens, 0)
            assert.strictEqual(state.streamedContent, '')
        })
    })

    describe('processEvent', () => {
        let state: GatewayStreamState

        beforeEach(() => {
            state = GatewayStreamProcessor.createState()
        })

        it('handles content event and accumulates text', () => {
            const ev: ParsedEvent = { type: 'content', data: { content: 'hello ' } }
            const result = GatewayStreamProcessor.processEvent(ev, state)
            assert.ok(result)
            assert.strictEqual(result.type, 'content')
            assert.strictEqual(result.data, 'hello ')
            assert.strictEqual(state.streamedContent, 'hello ')
            assert.strictEqual(state.lastContent, 'hello ')
        })

        it('deduplicates identical consecutive content', () => {
            const ev: ParsedEvent = { type: 'content', data: { content: 'same' } }
            GatewayStreamProcessor.processEvent(ev, state)
            const result = GatewayStreamProcessor.processEvent(ev, state) // same content again
            assert.strictEqual(result, null) // should be skipped
            assert.strictEqual(state.streamedContent, 'same') // not doubled
        })

        it('handles tool_start event', () => {
            const ev: ParsedEvent = {
                type: 'tool_start',
                data: { toolUseId: 'tool_123', name: 'my_tool', input: { key: 'val' } },
            }
            const result = GatewayStreamProcessor.processEvent(ev, state)
            assert.ok(result)
            assert.strictEqual(result.type, 'tool')
            assert.strictEqual(result.data.action, 'start')
            assert.ok(state.currentTool)
            assert.strictEqual(state.currentTool.id, 'tool_123')
            assert.strictEqual(state.currentTool.name, 'my_tool')
        })

        it('handles tool_input event and accumulates args', () => {
            // First start a tool
            GatewayStreamProcessor.processEvent(
                { type: 'tool_start', data: { toolUseId: 'tool_abc', name: 'calc', input: '' } },
                state
            )
            // Then send input
            const ev: ParsedEvent = { type: 'tool_input', data: { input: '{"x":1}' } }
            const result = GatewayStreamProcessor.processEvent(ev, state)
            assert.ok(result)
            assert.strictEqual(result.type, 'tool')
            assert.strictEqual(result.data.action, 'input')
            assert.ok(state.currentTool?._rawArgs.includes('{"x":1}'))
        })

        it('handles tool_stop event and finalizes tool', () => {
            GatewayStreamProcessor.processEvent(
                { type: 'tool_start', data: { toolUseId: 'tool_xyz', name: 'search', input: '' } },
                state
            )
            GatewayStreamProcessor.processEvent(
                { type: 'tool_input', data: { input: '{"query":"test"}' } },
                state
            )
            const result = GatewayStreamProcessor.processEvent({ type: 'tool_stop', data: {} }, state)
            assert.ok(result)
            assert.strictEqual(result.type, 'tool')
            assert.strictEqual(result.data.action, 'stop')
            assert.strictEqual(state.currentTool, null)
            assert.strictEqual(state.toolCalls.length, 1)
            assert.deepStrictEqual(state.toolCalls[0].input, { query: 'test' })
        })

        it('handles usage event and updates token counts', () => {
            const ev: ParsedEvent = {
                type: 'usage',
                data: { inputTokens: 100, outputTokens: 50 },
            }
            const result = GatewayStreamProcessor.processEvent(ev, state)
            assert.ok(result)
            assert.strictEqual(result.type, 'meta')
            assert.strictEqual(state.promptTokens, 100)
            assert.strictEqual(state.completionTokens, 50)
        })

        it('handles context_usage event', () => {
            const { sessionId } = GatewaySessionManager.manageSession(
                undefined,
                [{ role: 'user', content: 'hi' }],
                'amazon-q'
            )
            const sessionKey = 'ctx-test'
            const ev: ParsedEvent = {
                type: 'context_usage',
                data: { contextUsagePercentage: 42 },
            }
            const result = GatewayStreamProcessor.processEvent(ev, state, sessionKey, sessionId)
            assert.ok(result)
            assert.strictEqual(result.type, 'meta')
            assert.strictEqual(result.data.percentage, 42)
        })

        it('returns null for unknown event types', () => {
            const ev = { type: 'unknown_type', data: {} } as any
            const result = GatewayStreamProcessor.processEvent(ev, state)
            assert.strictEqual(result, null)
        })
    })

    describe('finalizeToolCalls', () => {
        it('flushes currentTool into toolCalls', () => {
            const state = GatewayStreamProcessor.createState()
            state.currentTool = {
                id: 'tool_flush',
                name: 'flush_tool',
                input: {},
                _rawArgs: '{"a":1}',
            }
            const result = GatewayStreamProcessor.finalizeToolCalls(state)
            assert.strictEqual(result.length, 1)
            assert.strictEqual(result[0].id, 'tool_flush')
            assert.deepStrictEqual(result[0].input, { a: 1 })
            assert.strictEqual(state.currentTool, null)
        })

        it('deduplicates tool calls by ID, keeping most complete', () => {
            const state = GatewayStreamProcessor.createState()
            state.toolCalls = [
                { id: 'dup_id', name: 'tool', input: { x: 1 }, _rawArgs: '{"x":1}' },
                { id: 'dup_id', name: 'tool', input: { x: 1, y: 2 }, _rawArgs: '{"x":1,"y":2}' },
            ]
            const result = GatewayStreamProcessor.finalizeToolCalls(state)
            assert.strictEqual(result.length, 1)
            assert.deepStrictEqual(result[0].input, { x: 1, y: 2 }) // more complete wins
        })

        it('preserves multiple distinct tool calls', () => {
            const state = GatewayStreamProcessor.createState()
            state.toolCalls = [
                { id: 'tool_1', name: 'search', input: { q: 'a' }, _rawArgs: '{"q":"a"}' },
                { id: 'tool_2', name: 'calc', input: { n: 5 }, _rawArgs: '{"n":5}' },
            ]
            const result = GatewayStreamProcessor.finalizeToolCalls(state)
            assert.strictEqual(result.length, 2)
        })
    })
})

// ── GatewayResponseBuilder ────────────────────────────────────────────────────

describe('GatewayResponseBuilder', () => {
    const sampleTools: GatewayToolCall[] = [
        { id: 'tc_1', name: 'search', input: { query: 'test' }, _rawArgs: '{"query":"test"}' },
    ]

    describe('buildOpenAIResponse', () => {
        it('builds a non-streaming response with text content', () => {
            const resp = GatewayResponseBuilder.buildOpenAIResponse(
                'chatcmpl-abc',
                'amazon-q',
                'Hello world',
                [],
                10,
                20
            )
            assert.strictEqual(resp.id, 'chatcmpl-abc')
            assert.strictEqual(resp.object, 'chat.completion')
            assert.strictEqual(resp.model, 'amazon-q')
            assert.strictEqual(resp.choices[0].message.role, 'assistant')
            assert.strictEqual(resp.choices[0].message.content, 'Hello world')
            assert.strictEqual(resp.choices[0].finish_reason, 'stop')
            assert.strictEqual(resp.usage.prompt_tokens, 10)
            assert.strictEqual(resp.usage.completion_tokens, 20)
            assert.strictEqual(resp.usage.total_tokens, 30)
        })

        it('sets finish_reason to tool_calls when tools present', () => {
            const resp = GatewayResponseBuilder.buildOpenAIResponse(
                'chatcmpl-xyz',
                'amazon-q',
                '',
                sampleTools,
                5,
                15
            )
            assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls')
            assert.ok(resp.choices[0].message.tool_calls)
            assert.strictEqual(resp.choices[0].message.tool_calls[0].id, 'tc_1')
            assert.strictEqual(resp.choices[0].message.tool_calls[0].function.name, 'search')
        })
    })

    describe('buildAnthropicResponse', () => {
        it('builds a response with text content block', () => {
            const resp = GatewayResponseBuilder.buildAnthropicResponse(
                'msg_abc123',
                'claude-sonnet-4.5',
                'Hello from Claude',
                [],
                15,
                25
            )
            assert.strictEqual(resp.id, 'msg_abc123')
            assert.strictEqual(resp.type, 'message')
            assert.strictEqual(resp.role, 'assistant')
            assert.strictEqual(resp.model, 'claude-sonnet-4.5')
            assert.strictEqual(resp.stop_reason, 'end_turn')
            assert.strictEqual(resp.content.length, 1)
            assert.strictEqual(resp.content[0].type, 'text')
            assert.strictEqual(resp.content[0].text, 'Hello from Claude')
            assert.strictEqual(resp.usage.input_tokens, 15)
            assert.strictEqual(resp.usage.output_tokens, 25)
        })

        it('sets stop_reason to tool_use when tools present', () => {
            const resp = GatewayResponseBuilder.buildAnthropicResponse(
                'msg_xyz',
                'claude-sonnet-4.5',
                '',
                sampleTools,
                5,
                10
            )
            assert.strictEqual(resp.stop_reason, 'tool_use')
            assert.strictEqual(resp.content.length, 1)
            assert.strictEqual(resp.content[0].type, 'tool_use')
            assert.strictEqual(resp.content[0].id, 'tc_1')
            assert.strictEqual(resp.content[0].name, 'search')
            assert.deepStrictEqual(resp.content[0].input, { query: 'test' })
        })

        it('includes both text and tool_use blocks when both present', () => {
            const resp = GatewayResponseBuilder.buildAnthropicResponse(
                'msg_both',
                'claude-sonnet-4.5',
                'Let me search for that',
                sampleTools,
                10,
                20
            )
            assert.strictEqual(resp.content.length, 2)
            assert.strictEqual(resp.content[0].type, 'text')
            assert.strictEqual(resp.content[1].type, 'tool_use')
        })

        it('includes cache token fields', () => {
            const resp = GatewayResponseBuilder.buildAnthropicResponse('msg_cache', 'claude-sonnet-4.5', 'hi', [], 1, 1)
            assert.strictEqual(resp.usage.cache_creation_input_tokens, 0)
            assert.strictEqual(resp.usage.cache_read_input_tokens, 0)
        })
    })
})
