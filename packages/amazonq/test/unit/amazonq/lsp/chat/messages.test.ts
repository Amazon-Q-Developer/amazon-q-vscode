/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as sinon from 'sinon'
import assert from 'assert'
import * as vscode from 'vscode'
import { BaseLanguageClient } from 'vscode-languageclient'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { registerMessageListeners } from '../../../../../src/lsp/chat/messages'
import { AmazonQChatViewProvider } from '../../../../../src/lsp/chat/webviewProvider'
import { secondaryAuth, authConnection, AuthFollowUpType } from 'aws-core-vscode/amazonq'
import { AmazonQPromptSettings, messages } from 'aws-core-vscode/shared'
import { ResponseError, ShowDocumentParams, ShowDocumentRequest } from '@aws/language-server-runtimes/protocol'

describe('registerMessageListeners', () => {
    let languageClient: BaseLanguageClient
    let provider: AmazonQChatViewProvider
    let sandbox: sinon.SinonSandbox
    let messageHandler: (message: any) => void | Promise<void>
    let showDocumentHandler: (params: ShowDocumentParams) => Promise<ShowDocumentParams | ResponseError>
    let showWarningMessageStub: sinon.SinonStub
    let openExternalStub: sinon.SinonStub
    let errorStub: sinon.SinonStub

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        errorStub = sandbox.stub()
        showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage')
        openExternalStub = sandbox.stub()

        const onRequestStub = sandbox.stub()
        languageClient = {
            info: sandbox.stub(),
            error: errorStub,
            sendNotification: sandbox.stub(),
            onRequest: onRequestStub,
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

        registerMessageListeners(languageClient, provider, Buffer.from('test-key'), openExternalStub)
        const showDocumentRegistration = onRequestStub
            .getCalls()
            .find((call) => call.firstArg === ShowDocumentRequest.method)
        assert.ok(showDocumentRegistration, 'ShowDocument request handler must be registered')
        showDocumentHandler = showDocumentRegistration.args[1]
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

    describe('ShowDocumentRequest external links', () => {
        for (const uri of [
            'vscode://attacker.extension/x',
            'file://evil-host/share/x',
            'ms-appinstaller:?source=https://example.com/app',
            'javascript:alert(1)',
        ]) {
            it(`rejects ${uri} without prompting or opening it`, async () => {
                const result = await showDocumentHandler({ uri, external: true })

                assert.ok(result instanceof ResponseError)
                sinon.assert.notCalled(showWarningMessageStub)
                sinon.assert.notCalled(openExternalStub)
            })
        }

        it('preserves an https OAuth URL after explicit confirmation', async () => {
            const params = {
                uri:
                    'https://auth.example.com/authorize?client_id=client-1&code_challenge=challenge-1' +
                    '&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&scope=openid&state=state-1',
                external: true,
            }
            openExternalStub.resolves(true)
            showWarningMessageStub.resolves('Open')

            const result = await showDocumentHandler(params)

            assert.deepStrictEqual(result, params)
            sinon.assert.calledOnceWithExactly(
                showWarningMessageStub,
                `Amazon Q wants to open an external link:\n${params.uri}`,
                { modal: true },
                'Open'
            )
            sinon.assert.calledOnce(openExternalStub)
            assert.strictEqual(openExternalStub.firstCall.args[0], params.uri)
        })

        it('falls back to the validated URI object when the string workaround fails', async () => {
            const params = { uri: 'https://example.com/path?client_id=client-1&state=state-1', external: true }
            openExternalStub.onFirstCall().rejects(new Error('string form unsupported'))
            openExternalStub.onSecondCall().resolves(true)
            showWarningMessageStub.resolves('Open')

            const result = await showDocumentHandler(params)

            assert.deepStrictEqual(result, params)
            sinon.assert.calledTwice(openExternalStub)
            assert.strictEqual(openExternalStub.firstCall.args[0], params.uri)
            assert.strictEqual(openExternalStub.secondCall.args[0].scheme, 'https')
        })

        it('does not open an https link when the user declines', async () => {
            showWarningMessageStub.resolves(undefined)

            const result = await showDocumentHandler({ uri: 'https://example.com/path', external: true })

            assert.ok(result instanceof ResponseError)
            sinon.assert.notCalled(openExternalStub)
        })
    })
})
