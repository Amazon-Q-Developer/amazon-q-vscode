/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as sinon from 'sinon'
import { BaseLanguageClient } from 'vscode-languageclient'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { describeChatMessageForLog, registerMessageListeners } from '../../../../../src/lsp/chat/messages'
import { AmazonQChatViewProvider } from '../../../../../src/lsp/chat/webviewProvider'
import { secondaryAuth, authConnection, AuthFollowUpType } from 'aws-core-vscode/amazonq'
import { AmazonQPromptSettings, messages } from 'aws-core-vscode/shared'

describe('registerMessageListeners', () => {
    let languageClient: BaseLanguageClient
    let provider: AmazonQChatViewProvider
    let sandbox: sinon.SinonSandbox
    let messageHandler: (message: any) => void | Promise<void>
    let errorStub: sinon.SinonStub

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        errorStub = sandbox.stub()

        languageClient = {
            info: sandbox.stub(),
            error: errorStub,
            sendNotification: sandbox.stub(),
            onRequest: sandbox.stub(),
            onNotification: sandbox.stub(),
        } as unknown as BaseLanguageClient

        provider = {
            webview: {
                onDidReceiveMessage: (callback: (message: any) => void | Promise<void>) => {
                    messageHandler = callback
                    return {
                        dispose: (): void => {},
                    }
                },
            },
        } as any

        registerMessageListeners(languageClient, provider, Buffer.from('test-key'))
    })

    afterEach(() => {
        sandbox.restore()
    })

    describe('AUTH_FOLLOW_UP_CLICKED', () => {
        let mockAuthUtil: AuthUtil
        let deleteConnectionStub: sinon.SinonStub
        let reauthenticateStub: sinon.SinonStub

        const authFollowUpClickedCommand = 'authFollowUpClicked'

        interface TestCase {
            authType: AuthFollowUpType
            stubToReject: sinon.SinonStub
            errorMessage: string
        }

        const testFailure = async (testCase: TestCase) => {
            testCase.stubToReject.rejects(new Error())

            await messageHandler({
                command: authFollowUpClickedCommand,
                params: {
                    authFollowupType: testCase.authType,
                },
            })

            sinon.assert.calledOnce(errorStub)
            sinon.assert.calledWith(errorStub, sinon.match(testCase.errorMessage))
        }

        beforeEach(() => {
            deleteConnectionStub = sandbox.stub().resolves()
            reauthenticateStub = sandbox.stub().resolves()

            mockAuthUtil = {
                reauthenticate: reauthenticateStub,
                secondaryAuth: {
                    deleteConnection: deleteConnectionStub,
                } as unknown as secondaryAuth.SecondaryAuth<authConnection.Connection>,
            } as unknown as AuthUtil

            sandbox.replaceGetter(AuthUtil, 'instance', () => mockAuthUtil)
        })

        it('handles re-authentication request', async () => {
            await messageHandler({
                command: authFollowUpClickedCommand,
                params: {
                    authFollowupType: 're-auth',
                },
            })

            sinon.assert.calledOnce(reauthenticateStub)
            sinon.assert.notCalled(deleteConnectionStub)
        })

        it('handles full authentication request', async () => {
            await messageHandler({
                command: authFollowUpClickedCommand,
                params: {
                    authFollowupType: 'full-auth',
                },
            })

            sinon.assert.notCalled(reauthenticateStub)
            sinon.assert.calledOnce(deleteConnectionStub)
        })

        it('logs error if re-authentication fails', async () => {
            await testFailure({
                authType: 're-auth',
                stubToReject: reauthenticateStub,
                errorMessage: 'Failed to re-authenticate',
            })
        })

        it('logs error if full authentication fails', async () => {
            await testFailure({
                authType: 'full-auth',
                stubToReject: deleteConnectionStub,
                errorMessage: 'Failed to authenticate',
            })
        })
    })

    describe('COPY_TO_CLIPBOARD', () => {
        let copyToClipboardStub: sinon.SinonStub
        const testCode = 'test'
        const copyMessage = {
            command: 'copyToClipboard',
            params: {
                code: testCode,
            },
        }

        beforeEach(() => {
            copyToClipboardStub = sandbox.stub().resolves()
            sandbox.stub(messages, 'copyToClipboard').get(() => copyToClipboardStub)
        })

        it('successfully copies code to clipboard', async () => {
            await messageHandler(copyMessage)

            sinon.assert.calledWith(copyToClipboardStub, testCode)
        })

        it('handles clipboard copy failure', async () => {
            const errorMessage = 'Failed to copy'
            copyToClipboardStub.rejects(new Error(errorMessage))

            await messageHandler(copyMessage)

            sinon.assert.calledWith(errorStub, `[VSCode Client] Failed to copy to clipboard: ${errorMessage}`)
        })
    })

    describe('CHAT_PROMPT_OPTION_ACKNOWLEDGED', () => {
        let disablePromptStub: sinon.SinonStub

        beforeEach(() => {
            disablePromptStub = sandbox.stub().resolves()
            sandbox.replaceGetter(AmazonQPromptSettings, 'instance', () => {
                return {
                    disablePrompt: disablePromptStub,
                } as unknown as AmazonQPromptSettings
            })
        })

        it('persists the pair programming acknowledgement', async () => {
            await messageHandler({
                command: 'chatPromptOptionAcknowledged',
                params: {
                    messageId: 'programmerModeCardId',
                },
            })

            sinon.assert.calledOnceWithExactly(disablePromptStub, 'amazonQChatPairProgramming')
        })

        it('persists the deprecation notice acknowledgement separately', async () => {
            await messageHandler({
                command: 'chatPromptOptionAcknowledged',
                params: {
                    messageId: 'client-deprecation-notice',
                },
            })

            sinon.assert.calledOnceWithExactly(disablePromptStub, 'amazonQChatDeprecationNotice')
        })
    })

    describe('logging MCP server clicks', () => {
        const mcpClick = () => ({
            command: 'aws/chat/mcpServerClick',
            params: {
                id: 'save-mcp',
                title: 'docs-server',
                optionsValues: {
                    name: 'docs-server',
                    transport: 'stdio',
                    command: 'npx',
                    args: [
                        { arg_key: '-y' },
                        { arg_key: '@docs/server' },
                        { arg_key: '--api-key=arg-value-345' },
                        { arg_key: '--token arg-value-567' },
                        { arg_key: '' },
                    ],
                    url: 'https://mcp.example.com/path-key-678/mcp?token=query-value-901',
                    timeout: '60',
                    scope: 'global',
                    env_variables: [{ env_var_name: 'API_TOKEN', env_var_value: 'env-value-123' }],
                    headers: [{ key: 'Authorization', value: 'Bearer header-value-456' }],
                    additional_env_variables: [{ env_var_name: 'EXTRA_TOKEN', env_var_value: 'env-value-789' }],
                    additional_headers: [{ key: 'X-Api-Key', value: 'header-value-012' }],
                    future_field: 'future-value-234',
                },
            },
        })

        it('logs MCP form values only for fields that do not hold tokens', async () => {
            const sendRequestStub = sandbox.stub().resolves({})
            ;(languageClient as any).sendRequest = sendRequestStub
            ;(provider.webview as any).postMessage = sandbox.stub().resolves(true)
            const message = mcpClick()

            await messageHandler(message)

            const logged = (languageClient.info as sinon.SinonStub)
                .getCalls()
                .map((c) => String(c.args[0]))
                .join('\n')
            for (const value of [
                'env-value-123',
                'header-value-456',
                'env-value-789',
                'header-value-012',
                'arg-value-345',
                'arg-value-567',
                'path-key-678',
                'query-value-901',
                'future-value-234',
            ]) {
                assert.ok(!logged.includes(value), `log contains ${value}`)
            }
            assert.ok(logged.includes('"env_variables":["API_TOKEN"]'))
            assert.ok(logged.includes('"headers":["Authorization"]'))
            assert.ok(logged.includes('"additional_env_variables":["EXTRA_TOKEN"]'))
            assert.ok(logged.includes('"additional_headers":["X-Api-Key"]'))
            assert.ok(logged.includes('"name":"docs-server","transport":"stdio","command":"npx"'))
            assert.ok(logged.includes('"args":"-y --api-key (2 values hidden)"'))
            assert.ok(logged.includes('"url":"https://mcp.example.com"'))
            assert.ok(logged.includes('"future_field":"(hidden)"'))

            // The language server still receives the values
            sinon.assert.calledWith(sendRequestStub, 'aws/chat/mcpServerClick', sinon.match(mcpClick().params))
            assert.deepStrictEqual(message, mcpClick())
        })

        it('logs other messages unchanged', () => {
            const message = { command: 'aws/chat/sendChatPrompt', params: { tabId: 't', prompt: { prompt: 'hi' } } }
            assert.strictEqual(describeChatMessageForLog(message), message)
        })

        it('logs an MCP click without form values unchanged', () => {
            const message = { command: 'aws/chat/mcpServerClick', params: { id: 'open-mcp-server', title: 'docs' } }
            assert.strictEqual(describeChatMessageForLog(message), message)
        })

        it('hides list fields that are not lists and values of unknown fields', () => {
            const logged = describeChatMessageForLog({
                command: 'aws/chat/mcpServerClick',
                params: {
                    id: 'save-mcp',
                    optionsValues: {
                        env_variables: 'A=v',
                        headers: 'Authorization: v',
                        args: '--api-key v',
                        url: 42,
                        extra: 'v',
                        nested: { token: 'v' },
                    },
                },
            })
            assert.deepStrictEqual(logged.params.optionsValues, {
                env_variables: '(hidden)',
                headers: '(hidden)',
                args: '(hidden)',
                url: '(invalid URL)',
                extra: '(hidden)',
                nested: '(hidden)',
            })
        })

        it('keeps flag names and tool permission choices', () => {
            const logged = describeChatMessageForLog({
                command: 'aws/chat/mcpServerClick',
                params: {
                    id: 'mcp-permission-change',
                    optionsValues: {
                        args: [
                            { arg_key: '-pvalue' },
                            { arg_key: '-' },
                            { arg_key: '--' },
                            { arg_key: '-v' },
                            { arg_key: '--token:arg-value-890' },
                            { arg_key: '' },
                        ],
                        search: 'alwaysAllow',
                        fetch: 'deny',
                        read: 'ask',
                    },
                },
            })
            assert.deepStrictEqual(logged.params.optionsValues, {
                args: '-- -v (3 values hidden)',
                search: 'alwaysAllow',
                fetch: 'deny',
                read: 'ask',
            })
        })
    })
})
