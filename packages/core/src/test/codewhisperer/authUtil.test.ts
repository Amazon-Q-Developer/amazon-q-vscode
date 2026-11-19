/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as sinon from 'sinon'
import { AuthUtil, amazonQScopes } from '../../codewhisperer/util/authUtil'
import globals from '../../shared/extensionGlobals'
import { createSsoProfile, createTestAuth } from '../credentials/testUtil'

describe('AuthUtil', function () {
    const startUrl = 'https://example.awsapps.com/start'
    const region = 'us-east-1'
    let auth: ReturnType<typeof createTestAuth>
    let authUtil: AuthUtil

    beforeEach(function () {
        auth = createTestAuth(globals.globalState)
        authUtil = new AuthUtil(auth)
    })

    it('reuses an existing valid enterprise SSO connection', async function () {
        const existing = await auth.createConnection(
            createSsoProfile({ startUrl, ssoRegion: region, scopes: amazonQScopes })
        )
        const createConnection = sinon.spy(auth, 'createConnection')
        const reauthenticate = sinon.spy(auth, 'reauthenticate')

        const connected = await authUtil.connectToEnterpriseSso(startUrl, region)

        assert.strictEqual(connected.id, existing.id)
        assert.ok(createConnection.notCalled)
        assert.ok(reauthenticate.notCalled)
    })

    it('reauthenticates and reuses an existing expired enterprise SSO connection', async function () {
        const existing = await auth.createInvalidSsoConnection(
            createSsoProfile({ startUrl, ssoRegion: region, scopes: amazonQScopes })
        )
        await auth.refreshConnectionState(existing)
        assert.strictEqual(auth.getConnectionState(existing), 'invalid')
        const createConnection = sinon.spy(auth, 'createConnection')
        const reauthenticate = sinon.spy(auth, 'reauthenticate')

        const connected = await authUtil.connectToEnterpriseSso(startUrl, region)

        assert.strictEqual(connected.id, existing.id)
        assert.ok(createConnection.notCalled)
        assert.ok(reauthenticate.calledOnce)
        assert.strictEqual(reauthenticate.firstCall.args[0].id, existing.id)
    })
})
