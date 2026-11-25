/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { AuthUtil, connectWithCustomization } from 'aws-core-vscode/codewhisperer'
import {
    customizationUtil,
    getTestWindow,
    resetCodeWhispererGlobalVariables,
    ssoConnection,
    testCommand,
} from 'aws-core-vscode/test'
import { cancel, Command, env, globals } from 'aws-core-vscode/shared'

describe('connectWithCustomization', function () {
    const startUrl = 'https://example.awsapps.com/start'
    const region = 'us-east-1'
    const signIn = 'Sign in'
    let targetCommand: Command<any> & vscode.Disposable
    let connect: sinon.SinonStub
    let isAutomation: sinon.SinonStub
    let activeConnection: sinon.SinonStub
    let restore: sinon.SinonStub

    beforeEach(async function () {
        await resetCodeWhispererGlobalVariables()
        isAutomation = sinon.stub(env, 'isAutomation').returns(false)
        connect = sinon.stub(AuthUtil.instance, 'connectToEnterpriseSso').resolves()
        activeConnection = sinon.stub(AuthUtil.instance, 'conn').value(undefined)
        restore = sinon.stub(AuthUtil.instance, 'restore').resolves()
        targetCommand = testCommand(connectWithCustomization)
    })

    afterEach(function () {
        targetCommand.dispose()
        sinon.restore()
    })

    it('confirms the exact target identity provider before connecting', async function () {
        getTestWindow().onDidShowMessage((message) => {
            assert.ok(!message.message.includes('replaces'))
            assert.ok(message.message.includes('Host: example.awsapps.com'))
            assert.ok(message.message.includes('Region: us-east-1'))
            assert.ok(message.message.includes(`URL: ${startUrl}`))
            message.selectItem(signIn)
        })

        await targetCommand.execute('test', startUrl, region)

        assert.ok(connect.calledOnceWith(startUrl, region))
        assert.ok(restore.calledOnce)
    })

    it('warns when connecting will replace the current connection', async function () {
        activeConnection.value(ssoConnection)
        getTestWindow().onDidShowMessage((message) => {
            assert.ok(message.message.includes('replaces your current Amazon Q connection'))
            message.selectItem(signIn)
        })

        await targetCommand.execute('test', startUrl, region)

        assert.ok(connect.calledOnceWith(startUrl, region))
    })

    it('does not warn about replacement when reconnecting to the current identity provider', async function () {
        activeConnection.value({ ...ssoConnection, startUrl: `${startUrl}/` })
        getTestWindow().onDidShowMessage((message) => {
            assert.ok(!message.message.includes('replaces'))
            message.selectItem(signIn)
        })

        await targetCommand.execute('test', startUrl, region)

        assert.ok(connect.calledOnceWith(startUrl, region))
    })

    it('connects without a confirmation dialog in an automated production extension host', async function () {
        isAutomation.returns(true)
        sinon.stub(globals.context, 'extensionMode').value(vscode.ExtensionMode.Production)

        await targetCommand.execute('test', startUrl, region)

        assert.ok(connect.calledOnceWith(startUrl, region))
        assert.ok(restore.notCalled)
        assert.deepStrictEqual(getTestWindow().shownMessages, [])
    })

    it('accepts null arguments as omitted and prompts interactively', async function () {
        let prompted = false
        const nullArgument = JSON.parse('null')
        getTestWindow().onDidShowInputBox((input) => {
            prompted = true
            input.hide()
        })

        await targetCommand.execute('test', nullArgument, nullArgument)

        assert.ok(prompted)
        assert.ok(connect.notCalled)
    })

    it('accepts a well-formed region not present in endpoint metadata', async function () {
        const futureRegion = 'ap-southeast-10'
        isAutomation.returns(true)

        await targetCommand.execute('test', startUrl, futureRegion)

        assert.ok(connect.calledOnceWith(startUrl, futureRegion))
    })

    it('normalizes the region before connecting', async function () {
        getTestWindow().onDidShowMessage((message) => message.selectItem(signIn))

        await targetCommand.execute('test', startUrl, region.toUpperCase())

        assert.ok(connect.calledOnceWith(startUrl, region))
    })

    it('selects a customization after connecting', async function () {
        const customizationArn = 'arn:aws:codewhisperer:us-east-1:123456789012:customization/example'
        const customization = { arn: customizationArn, name: 'example', description: 'example' }
        sinon.stub(customizationUtil, 'getPersistedCustomizations').returns([customization])
        const selectCustomization = sinon.stub(customizationUtil, 'selectCustomization').resolves()
        getTestWindow().onDidShowMessage((message) => message.selectItem(signIn))

        await targetCommand.execute('test', startUrl, region, customizationArn)

        assert.ok(connect.calledOnceWith(startUrl, region))
        assert.ok(selectCustomization.calledOnceWith(customization))
    })

    it('does not connect when the user cancels', async function () {
        getTestWindow().onDidShowMessage((message) => message.selectItem(cancel))

        await targetCommand.execute('test', startUrl, region)

        assert.ok(connect.notCalled)
    })

    it('accepts a custom redirect start URL', async function () {
        const customStartUrl = 'https://login.example.invalid/custom/start'
        isAutomation.returns(true)

        await targetCommand.execute('test', customStartUrl, region)

        assert.ok(connect.calledOnceWith(customStartUrl, region))
    })

    it('shows and stores the same validated URL', async function () {
        const copiedStartUrl = 'https://EXAMPLE.awsapps.com/start/#/'
        getTestWindow().onDidShowMessage((message) => {
            assert.ok(message.message.includes(`URL: ${copiedStartUrl}`))
            message.selectItem(signIn)
        })

        await targetCommand.execute('test', copiedStartUrl, region)

        assert.ok(connect.calledOnceWith(copiedStartUrl, region))
    })

    it('accepts an uppercase access portal path', async function () {
        const uppercasePath = 'https://example.awsapps.com/START'
        isAutomation.returns(true)

        await targetCommand.execute('test', uppercasePath, region)

        assert.ok(connect.calledOnceWith(uppercasePath, region))
    })

    it('rejects an unsafe start URL', async function () {
        const errorMessage = getTestWindow().waitForMessage(/must not include user information/)
        await Promise.all([
            errorMessage.then((message) => message.close()),
            targetCommand.execute('test', 'https://user@example.invalid/start', region),
        ])

        assert.ok(connect.notCalled)
    })

    it('rejects a hostname with a trailing dot', async function () {
        const errorMessage = getTestWindow().waitForMessage(/must not end with a dot/)
        await Promise.all([
            errorMessage.then((message) => message.close()),
            targetCommand.execute('test', 'https://example.awsapps.com./unexpected', region),
        ])

        assert.ok(connect.notCalled)
    })

    it('rejects non-null non-string connection arguments', async function () {
        const errorMessage = getTestWindow().waitForMessage(/startUrl and region must be strings/)
        await Promise.all([
            errorMessage.then((message) => message.close()),
            targetCommand.execute('test', 123 as any, region),
        ])

        assert.ok(connect.notCalled)
    })

    it('rejects a malformed region', async function () {
        const errorMessage = getTestWindow().waitForMessage(/Invalid SSO region/)
        await Promise.all([
            errorMessage.then((message) => message.close()),
            targetCommand.execute('test', startUrl, 'evil.com/#'),
        ])

        assert.ok(connect.notCalled)
    })
})
