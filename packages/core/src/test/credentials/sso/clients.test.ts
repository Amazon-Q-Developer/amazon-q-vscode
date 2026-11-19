/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { SSOOIDC } from '@aws-sdk/client-sso-oidc'
import { OidcClient } from '../../../auth/sso/clients'
import {
    areSsoUrlsEquivalent,
    normalizeSsoUrl,
    validateSsoRegionFormat,
    validateSsoUrlForConnection,
    validateSsoUrlFormat,
} from '../../../auth/sso/validation'
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
        const urls = ['https://example.invalid/start', 'not a URL']

        for (const url of urls) {
            assert.match(validateSsoUrlFormat(url) ?? '', /URL possibly invalid/)
        }
    })

    it('preserves the warning-only validation used by interactive login', function () {
        assert.strictEqual(validateSsoUrlFormat('http://d-0123456789.awsapps.com/start'), undefined)
    })

    it('accepts safe SSO URL variants for a connection', function () {
        const urls = [
            'https://ssoins-1234567890abcdef.portal.us-east-1.app.aws',
            'https://ssoins-1234567890abcdef.us-east-1.portal.amazonaws.com',
            'https://d-0123456789.awsapps.com/start/',
            'https://d-0123456789.awsapps.com/start#/',
            'https://d-0123456789.awsapps.com/START',
            'https://login.example.invalid/custom/start',
        ]

        for (const url of urls) {
            assert.strictEqual(validateSsoUrlForConnection(url), undefined)
        }
    })

    it('rejects unsafe SSO URL structures for a connection', function () {
        const urls = [
            'http://example.invalid/start',
            'https://user@example.invalid/start',
            String.raw`https://example.invalid\@identitycenter.amazonaws.com/start`,
            'https://example.invalid/start#unexpected',
            'https://d-0123456789.awsapps.com/unexpected',
            'https://d-0123456789.awsapps.com./unexpected',
        ]

        for (const url of urls) {
            assert.ok(validateSsoUrlForConnection(url))
        }
    })

    it('normalizes a copied trailing fragment and uppercase host', function () {
        assert.strictEqual(
            normalizeSsoUrl('https://D-0123456789.AWSAPPS.COM/start/#/'),
            'https://d-0123456789.awsapps.com/start'
        )
    })

    it('normalizes the access portal path case for comparison', function () {
        assert.strictEqual(
            normalizeSsoUrl('https://d-0123456789.awsapps.com/START/'),
            'https://d-0123456789.awsapps.com/start'
        )
        assert.ok(
            areSsoUrlsEquivalent('https://d-0123456789.awsapps.com/START/', 'https://d-0123456789.awsapps.com/start')
        )
    })

    it('accepts valid SSO region formats', function () {
        for (const region of ['us-east-1', 'us-gov-west-1', 'ap-southeast-10']) {
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
        const authorizeUrl = await createClient('US-EAST-1').authorize(authorizeRequest)

        assert.strictEqual(new URL(authorizeUrl).hostname, 'oidc.us-east-1.amazonaws.com')
    })

    it('rejects a region that can alter the authorize URL authority', async function () {
        await assert.rejects(createClient('evil.com/#').authorize(authorizeRequest), /Invalid SSO region/)
    })

    it('allows an OIDC client to be created for a stored profile with a non-matching region', function () {
        assert.doesNotThrow(() => OidcClient.create('evil.com/#'))
    })
})
