/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import sinon from 'sinon'
import { LanguageClient } from 'vscode-languageclient/node'
import { AuthUtil, clearQDevAccessBlocked, getQDevAccessBlockedMessage } from 'aws-core-vscode/codewhisperer'
import { registerQDevAccessBlockedHandler } from '../../../../src/lsp/qDevAccessBlockedHandler'

/**
 * The runtime does not deliver the server's notification id verbatim -- RouterByServerName replaces it
 * with base64 of {"serverName":...,"id":...} so followups can be routed back. Tests have to send what
 * the client actually receives, not what the server set, or they pass against a shape that never
 * reaches production.
 */
function routedId(id: string, serverName = 'AWS Language Server for Amazon Q Developer (Token)'): string {
    return Buffer.from(JSON.stringify({ serverName, id }), 'utf-8').toString('base64')
}

const blockedMessage = 'Please visit https://kiro.dev/ to purchase a Kiro subscription.'

describe('qDevAccessBlockedHandler', function () {
    let sandbox: sinon.SinonSandbox
    let handler: (params: unknown) => Promise<void>
    let deleteConnection: sinon.SinonStub

    beforeEach(async function () {
        sandbox = sinon.createSandbox()

        deleteConnection = sandbox.stub()
        sandbox.stub(AuthUtil, 'instance').value({
            setVscodeContextProps: sandbox.stub().resolves(),
            secondaryAuth: { deleteConnection },
        })

        const client = {
            onNotification: (_method: string, cb: (params: unknown) => Promise<void>) => {
                handler = cb
            },
        }
        registerQDevAccessBlockedHandler(client as unknown as LanguageClient)

        await clearQDevAccessBlocked()
    })

    afterEach(async function () {
        sandbox.restore()
        await clearQDevAccessBlocked()
    })

    it('records the block and signs out when the routed id matches', async function () {
        await handler({
            id: routedId('qDevPluginAccessBlocked'),
            type: 1,
            content: { title: 'Amazon Q Developer', text: blockedMessage },
        })

        // The message is stored verbatim: it is the service's own copy and the only thing that tells
        // the user what to do about it.
        assert.strictEqual(getQDevAccessBlockedMessage(), blockedMessage)
        assert.strictEqual(deleteConnection.calledOnce, true)
    })

    it('also matches an unrouted id, so a server that sends it plainly still works', async function () {
        await handler({ id: 'qDevPluginAccessBlocked', type: 1, content: { text: blockedMessage } })

        assert.strictEqual(getQDevAccessBlockedMessage(), blockedMessage)
    })

    it('ignores an unrelated error notification that shares the title', async function () {
        // Regression guard for the removed title-based matching. Acting on this notification signs the
        // user out, so a lookalike must not match: 'Amazon Q Developer' is a plausible title for any
        // future error the server sends, and matching it would sign out a working user.
        await handler({
            id: routedId('someOtherNotification'),
            type: 1,
            content: { title: 'Amazon Q Developer', text: 'Something else went wrong.' },
        })

        assert.strictEqual(getQDevAccessBlockedMessage(), undefined)
        assert.strictEqual(deleteConnection.notCalled, true)
    })

    it('ignores a notification with no id at all', async function () {
        await handler({ type: 1, content: { title: 'Amazon Q Developer', text: blockedMessage } })

        assert.strictEqual(getQDevAccessBlockedMessage(), undefined)
        assert.strictEqual(deleteConnection.notCalled, true)
    })

    it('does not sign out when the message is missing', async function () {
        // Signing out without an explanation to show would be strictly worse than doing nothing: the
        // user would be ejected with no idea why.
        await handler({ id: routedId('qDevPluginAccessBlocked'), type: 1, content: { text: '   ' } })

        assert.strictEqual(getQDevAccessBlockedMessage(), undefined)
        assert.strictEqual(deleteConnection.notCalled, true)
    })

    it('never throws, even when signing out fails', async function () {
        deleteConnection.rejects(new Error('sign out exploded'))

        // This runs on the language client's notification dispatch; throwing would disturb the rest of
        // the connection for a user who is already in a broken state.
        await handler({ id: routedId('qDevPluginAccessBlocked'), type: 1, content: { text: blockedMessage } })

        // The block was still recorded, so the user gets the explanation even though sign-out failed.
        assert.strictEqual(getQDevAccessBlockedMessage(), blockedMessage)
    })

    it('is idempotent when the server reports the block more than once', async function () {
        const params = { id: routedId('qDevPluginAccessBlocked'), type: 1, content: { text: blockedMessage } }

        await handler(params)
        await handler(params)

        assert.strictEqual(getQDevAccessBlockedMessage(), blockedMessage)
        assert.strictEqual(deleteConnection.callCount, 2, 'each report tears down whatever connection exists')
    })
})
