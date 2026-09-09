/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { SinonSandbox, createSandbox } from 'sinon'
import { assertTelemetry } from '../../../testUtil'
import assert from 'assert'
import {
    createBuilderIdProfile,
    createSsoProfile,
    createTestAuth,
    mockRegistration,
} from '../../../credentials/testUtil'
import { Auth } from '../../../../auth'
import { AmazonQLoginWebview } from '../../../../login/webview/vue/amazonq/backend_amazonq'
import { isBuilderIdConnection, isIdcSsoConnection } from '../../../../auth/connection'
import { amazonQScopes, AuthUtil } from '../../../../codewhisperer/util/authUtil'
import { getOpenExternalStub } from '../../../globalSetup.test'
import globals from '../../../../shared/extensionGlobals'
import {
    clearQDevAccessBlocked,
    isQDevAccessBlocked,
    setQDevAccessBlocked,
} from '../../../../codewhisperer/util/qDevAccessBlocked'

// TODO: remove auth page and tests
describe('Amazon Q Login', function () {
    const region = 'fakeRegion'
    const startUrl = 'fakeUrl'

    let sandbox: SinonSandbox
    let auth: ReturnType<typeof createTestAuth>
    let authUtil: AuthUtil
    let backend: AmazonQLoginWebview

    beforeEach(function () {
        sandbox = createSandbox()
        auth = createTestAuth(globals.globalState)
        authUtil = new AuthUtil(auth)
        sandbox.stub(Auth, 'instance').value(auth)
        sandbox.stub(AuthUtil, 'instance').value(authUtil)
        getOpenExternalStub().resolves(true)

        backend = new AmazonQLoginWebview()
    })

    afterEach(function () {
        sandbox.restore()
    })

    it('signs into builder ID and emits telemetry', async function () {
        await backend.startBuilderIdSetup()

        assert.ok(isBuilderIdConnection(auth.activeConnection))
        assert.deepStrictEqual(auth.activeConnection.scopes, amazonQScopes)
        assert.deepStrictEqual(auth.activeConnection.state, 'valid')

        assertTelemetry('auth_addConnection', {
            result: 'Succeeded',
            credentialSourceId: 'awsId',
            authEnabledFeatures: 'codewhisperer',
            isReAuth: false,
            ssoRegistrationExpiresAt: mockRegistration.expiresAt.toISOString(),
            ssoRegistrationClientId: mockRegistration.clientId,
        })
    })

    it('signs into IdC and emits telemetry', async function () {
        await backend.startEnterpriseSetup(startUrl, region)

        assert.ok(isIdcSsoConnection(auth.activeConnection))
        assert.deepStrictEqual(auth.activeConnection.scopes, amazonQScopes)
        assert.deepStrictEqual(auth.activeConnection.state, 'valid')
        assert.deepStrictEqual(auth.activeConnection.startUrl, startUrl)
        assert.deepStrictEqual(auth.activeConnection.ssoRegion, region)

        assertTelemetry('auth_addConnection', {
            result: 'Succeeded',
            credentialSourceId: 'iamIdentityCenter',
            authEnabledFeatures: 'codewhisperer',
            credentialStartUrl: startUrl,
            awsRegion: region,
            isReAuth: false,
            ssoRegistrationExpiresAt: mockRegistration.expiresAt.toISOString(),
            ssoRegistrationClientId: mockRegistration.clientId,
        })
    })

    it('reauths builder ID and emits telemetry', async function () {
        const conn = await auth.createInvalidSsoConnection(createBuilderIdProfile({ scopes: amazonQScopes }))
        await auth.useConnection(conn)

        // method under test
        await backend.reauthenticateConnection()

        assert.deepStrictEqual(auth.activeConnection?.state, 'valid')

        assertTelemetry('auth_addConnection', {
            result: 'Succeeded',
            credentialSourceId: 'awsId',
            authEnabledFeatures: 'codewhisperer',
            isReAuth: true,
            ssoRegistrationExpiresAt: mockRegistration.expiresAt.toISOString(),
            ssoRegistrationClientId: mockRegistration.clientId,
        })
    })

    it('reauths IdC and emits telemetry', async function () {
        const conn = await auth.createInvalidSsoConnection(
            createSsoProfile({ scopes: amazonQScopes, startUrl, ssoRegion: region })
        )
        await auth.useConnection(conn)

        // method under test
        await backend.reauthenticateConnection()

        assert.deepStrictEqual(auth.activeConnection?.state, 'valid')

        assertTelemetry('auth_addConnection', {
            result: 'Succeeded',
            credentialSourceId: 'iamIdentityCenter',
            authEnabledFeatures: 'codewhisperer',
            credentialStartUrl: startUrl,
            awsRegion: region,
            isReAuth: true,
            ssoRegistrationExpiresAt: mockRegistration.expiresAt.toISOString(),
            ssoRegistrationClientId: mockRegistration.clientId,
        })
    })

    it('signs out of reauth and emits telemetry', async function () {
        const conn = await auth.createInvalidSsoConnection(
            createSsoProfile({ scopes: amazonQScopes, startUrl, ssoRegion: region })
        )
        await auth.useConnection(conn)

        // method under test
        await backend.signout()

        assert.equal(auth.activeConnection, undefined)

        assertTelemetry('auth_addConnection', {
            result: 'Cancelled',
            credentialSourceId: 'iamIdentityCenter',
            authEnabledFeatures: 'codewhisperer',
            credentialStartUrl: startUrl,
            awsRegion: region,
            isReAuth: true,
            ssoRegistrationExpiresAt: mockRegistration.expiresAt.toISOString(),
            ssoRegistrationClientId: mockRegistration.clientId,
        })
    })

    describe('Q Developer access blocked', function () {
        const blockedMessage = 'Please visit https://kiro.dev/ to purchase a Kiro subscription.'

        afterEach(async function () {
            await clearQDevAccessBlocked()
        })

        it('routes a blocked identity to the profile-selection stage', async function () {
            await setQDevAccessBlocked(blockedMessage)

            await backend.refreshAuthState()

            // That stage renders RegionProfileSelector, which owns the blocked screen.
            assert.strictEqual(await backend.getAuthState(), 'PENDING_PROFILE_SELECTION')
        })

        it('returns the service message verbatim instead of listing profiles', async function () {
            await setQDevAccessBlocked(blockedMessage)

            const result = await backend.listRegionProfiles()

            // Prefixed with the sentinel the frontend matches on, and the message itself unaltered --
            // it is the service's own copy and the only thing telling the user what to do.
            assert.strictEqual(typeof result, 'string')
            assert.ok((result as string).endsWith(blockedMessage))
        })

        it('does not break the webview when it reports readiness on the blocked screen', async function () {
            // Regression guard. Routing to PENDING_PROFILE_SELECTION without initialising the load
            // metadata made the webview throw on load:
            //   Webview backend command failed: "setUiReady()"
            //   TypeError: Cannot read properties of undefined (reading 'start')
            // setDidLoad dereferences loadMetadata!.start non-optionally, so entering that stage
            // without it broke the login view for exactly the users this feature exists to help.
            await setQDevAccessBlocked(blockedMessage)
            await backend.refreshAuthState()

            assert.doesNotThrow(() => backend.setUiReady('selectProfile'))
        })

        it('clears the blocked flag and notifies the webview when there is no connection', async function () {
            await setQDevAccessBlocked(blockedMessage)
            assert.strictEqual(isQDevAccessBlocked(), true)

            let notified = 0
            const listener = backend.onActiveConnectionModified.event(() => (notified += 1))

            try {
                // Reacting to the block already signed the user out, so Go back runs with no active
                // connection. Clearing alone leaves the user stuck: root.vue only re-evaluates the
                // auth stage on this event, and signout() -- which would normally fire it -- is skipped.
                await backend.signOutIfConnected()
            } finally {
                listener.dispose()
            }

            assert.strictEqual(isQDevAccessBlocked(), false)
            assert.strictEqual(notified, 1)
            assert.strictEqual(await backend.getAuthState(), 'LOGIN')
        })
    })
})
