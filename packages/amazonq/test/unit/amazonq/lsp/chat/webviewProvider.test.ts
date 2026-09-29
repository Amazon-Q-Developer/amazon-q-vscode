/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as sinon from 'sinon'
import { BaseLanguageClient } from 'vscode-languageclient'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { featureConfig } from 'aws-core-vscode/amazonq'
import { AmazonQPromptSettings, globals } from 'aws-core-vscode/shared'
import { AmazonQChatViewProvider } from '../../../../../src/lsp/chat/webviewProvider'

describe('AmazonQChatViewProvider', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        sandbox.stub(featureConfig, 'getFeatureConfigs').resolves('{}')
        sandbox.stub(globals.globalState, 'tryGet').returns(0)
        sandbox.replaceGetter(AuthUtil, 'instance', () => {
            return {
                getChatAuthState: sandbox.stub().resolves({ amazonQ: 'connected' }),
                regionProfileManager: {
                    activeRegionProfile: undefined,
                    profiles: [],
                },
            } as unknown as AuthUtil
        })
    })

    afterEach(() => {
        sandbox.restore()
    })

    it('forwards the old and new prompt acknowledgements independently', async () => {
        const isPromptEnabled = sandbox.stub()
        isPromptEnabled.withArgs('amazonQChatDisclaimer').returns(false)
        isPromptEnabled.withArgs('amazonQChatPairProgramming').returns(false)
        isPromptEnabled.withArgs('amazonQChatDeprecationNotice').returns(true)
        sandbox.replaceGetter(AmazonQPromptSettings, 'instance', () => {
            return {
                isPromptEnabled,
            } as unknown as AmazonQPromptSettings
        })

        const provider = new AmazonQChatViewProvider('', {} as BaseLanguageClient)
        const content = await (provider as any).getWebviewContent()

        sinon.assert.match(content, 'disclaimerAcknowledged: true')
        sinon.assert.match(content, 'pairProgrammingAcknowledged: true')
        sinon.assert.match(content, 'deprecationNoticeAcknowledged: false')
    })

    it('forwards an acknowledged deprecation notice independently from the old feature card', async () => {
        const isPromptEnabled = sandbox.stub()
        isPromptEnabled.withArgs('amazonQChatDisclaimer').returns(false)
        isPromptEnabled.withArgs('amazonQChatPairProgramming').returns(true)
        isPromptEnabled.withArgs('amazonQChatDeprecationNotice').returns(false)
        sandbox.replaceGetter(AmazonQPromptSettings, 'instance', () => {
            return {
                isPromptEnabled,
            } as unknown as AmazonQPromptSettings
        })

        const provider = new AmazonQChatViewProvider('', {} as BaseLanguageClient)
        const content = await (provider as any).getWebviewContent()

        sinon.assert.match(content, 'disclaimerAcknowledged: true')
        sinon.assert.match(content, 'pairProgrammingAcknowledged: false')
        sinon.assert.match(content, 'deprecationNoticeAcknowledged: true')
    })
})
