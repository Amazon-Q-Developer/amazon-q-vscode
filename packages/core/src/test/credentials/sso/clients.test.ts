/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { SSOOIDC } from '@aws-sdk/client-sso-oidc'
import { OidcClient } from '../../../auth/sso/clients'
import { validateSsoRegionFormat, validateSsoUrlFormat } from '../../../auth/sso/validation'
import globals from '../../../shared/extensionGlobals'

describe('SSO validation', function () {
    it('accepts trusted SSO start URL formats', function () {
        const urls = [
            'https://d-0123456789.awsapps.com/start',
            'https://identitycenter.amazonaws.com/ssoins-1234567890abcdef',
        ]

        for (const url of urls) {
            assert.strictEqual(validateSsoUrlFormat(url), undefined)
        }
    })

    it('rejects untrusted SSO start URL formats', function () {
        const urls = ['http://d-0123456789.awsapps.com/start', 'https://attacker.example/path.awsapps.com/start']

        for (const url of urls) {
            assert.match(validateSsoUrlFormat(url) ?? '', /URL possibly invalid/)
        }
    })

    it('accepts valid SSO region formats', function () {
        for (const region of ['us-east-1', 'us-gov-west-1']) {
            assert.strictEqual(validateSsoRegionFormat(region), undefined)
        }
    })

    it('rejects SSO regions that could alter a URL authority', function () {
        for (const region of ['evil.com/#', 'us-east-1.evil.com']) {
            assert.match(validateSsoRegionFormat(region) ?? '', /Invalid SSO region/)
        }
    })
})

describe('OidcClient', function () {
    const authorizeRequest = {
        responseType: 'code',
        clientId: 'client',
        redirectUri: 'https://example.com/callback',
        scopes: ['scope'],
        state: 'state',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
    }

    function createClient(region: string) {
        return new OidcClient(new SSOOIDC({ region }), globals.clock)
    }

    it('constructs the authorize URL for a valid region', async function () {
        const authorizeUrl = await createClient('us-east-1').authorize(authorizeRequest)

        assert.strictEqual(new URL(authorizeUrl).hostname, 'oidc.us-east-1.amazonaws.com')
    })

    it('rejects a region that can alter the authorize URL authority', async function () {
        await assert.rejects(createClient('evil.com/#').authorize(authorizeRequest), /Invalid SSO region/)
    })

    it('rejects an invalid region before creating an OIDC client', function () {
        assert.throws(() => OidcClient.create('evil.com/#'), /Invalid SSO region/)
    })
})
