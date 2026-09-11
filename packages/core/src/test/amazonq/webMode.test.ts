/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import sinon from 'sinon'
import globals from '../../shared/extensionGlobals'
import { showWebModeUnsupportedMessage, webModeUnsupportedMessage } from '../../amazonq/webMode'
import { createSignIn } from '../../codewhisperer/ui/codeWhispererNodes'
import { getTestWindow } from '../shared/vscode/window'

/** `waitForMessage` treats strings as regex patterns, so match on a prefix without special characters. */
const webModeMessagePattern = /^Amazon Q is not available in the browser-only version of VS Code/

describe('amazonq webMode', function () {
    let sandbox: sinon.SinonSandbox

    beforeEach(function () {
        sandbox = sinon.createSandbox()
    })

    afterEach(function () {
        sandbox.restore()
    })

    describe('showWebModeUnsupportedMessage', function () {
        it('shows an informational notification', async function () {
            const shown = getTestWindow().waitForMessage(webModeMessagePattern)
            void showWebModeUnsupportedMessage()
            const message = await shown
            message.assertInfo(webModeUnsupportedMessage)
        })
    })

    describe('createSignIn', function () {
        it('explains that Amazon Q is unavailable when running in the web extension host', async function () {
            sandbox.stub(globals, 'isWeb').value(true)

            const shown = getTestWindow().waitForMessage(webModeMessagePattern)
            createSignIn().onClick?.()
            const message = await shown
            message.assertInfo(webModeUnsupportedMessage)
        })

        it('does not show the web notice outside of the web extension host', function () {
            sandbox.stub(globals, 'isWeb').value(false)

            createSignIn().onClick?.()
            assert.strictEqual(
                getTestWindow().shownMessages.some((m) => m.message === webModeUnsupportedMessage),
                false
            )
        })
    })
})
