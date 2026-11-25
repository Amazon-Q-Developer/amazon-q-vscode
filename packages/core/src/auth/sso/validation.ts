/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { UnknownError } from '../../shared/errors'
import { Auth } from '../auth'
import { SsoConnection, hasScopes, isAnySsoConnection } from '../connection'
import { ssoRegionFormatRegex, ssoUrlFormatMessage, ssoUrlFormatRegex } from './constants'

/**
 * Returns an error message if the url is not properly formatted.
 * Otherwise, returns undefined.
 */
export function validateSsoUrlFormat(url: string) {
    if (!ssoUrlFormatRegex.test(url)) {
        return ssoUrlFormatMessage
    }
}

/**
 * Rejects URL structures that can obscure the identity provider shown to the user.
 * Unlike {@link validateSsoUrlFormat}, this accepts custom redirect URLs.
 */
export function validateSsoUrlForConnection(url: string) {
    if (url.includes('\\')) {
        return 'Start URL must not contain backslashes.'
    }

    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:') {
            return 'Start URL must use HTTPS.'
        }
        if (!parsed.hostname) {
            return 'Start URL must include a hostname.'
        }
        if (parsed.hostname.endsWith('.')) {
            return 'Start URL hostname must not end with a dot.'
        }
        if (parsed.username || parsed.password) {
            return 'Start URL must not include user information.'
        }
        if (parsed.search) {
            return 'Start URL must not include query parameters.'
        }
        if (parsed.hash && parsed.hash !== '#/') {
            return 'Start URL must not include a fragment.'
        }

        const hostname = parsed.hostname.toLowerCase()
        if (hostname.endsWith('.awsapps.com') && !/^\/start\/?$/i.test(parsed.pathname)) {
            return 'AWS access portal URLs must use the /start path.'
        }
        if (hostname === 'identitycenter.amazonaws.com' && !/^\/ssoins-[\da-z]{16}\/?$/i.test(parsed.pathname)) {
            return 'Identity Center URLs must include a valid SSO instance path.'
        }
    } catch (err) {
        return `URL is malformed: ${UnknownError.cast(err).message}`
    }
}

/**
 * Canonicalizes a URL after {@link validateSsoUrlForConnection} succeeds.
 */
export function normalizeSsoUrl(url: string) {
    const parsed = new URL(url)
    parsed.hash = ''
    const hostname = parsed.hostname.toLowerCase()
    if (hostname.endsWith('.awsapps.com') && /^\/start\/?$/i.test(parsed.pathname)) {
        parsed.pathname = '/start'
    } else if (hostname === 'identitycenter.amazonaws.com' && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.slice(0, -1)
    }

    return parsed.toString()
}

export function areSsoUrlsEquivalent(left: string, right: string): boolean {
    try {
        return normalizeSsoUrl(left).toLowerCase() === normalizeSsoUrl(right).toLowerCase()
    } catch {
        // Preserve the previous matching behavior for stored profiles that cannot be parsed as URLs.
        return left.toLowerCase() === right.toLowerCase()
    }
}

export function validateSsoRegionFormat(region: string) {
    if (!ssoRegionFormatRegex.test(region)) {
        return `Invalid SSO region: ${region}`
    }
}

export async function validateIsNewSsoUrlAsync(
    auth: Auth,
    url: string,
    requiredScopes?: string[]
): Promise<string | undefined> {
    return auth.listConnections().then((conns) => {
        return validateIsNewSsoUrl(url, requiredScopes, conns.filter(isAnySsoConnection))
    })
}

export function validateIsNewSsoUrl(
    url: string,
    requiredScopes?: string[],
    existingSsoConns: SsoConnection[] = []
): string | undefined {
    try {
        const uri = vscode.Uri.parse(url, true)
        const isSameAuthority = (a: vscode.Uri, b: vscode.Uri) =>
            a.authority.toLowerCase() === b.authority.toLowerCase()
        const oldConn = existingSsoConns.find((conn) => isSameAuthority(vscode.Uri.parse(conn.startUrl), uri))

        if (oldConn && (!requiredScopes || hasScopes(oldConn, requiredScopes))) {
            return 'A connection for this start URL already exists. Sign out before creating a new one.'
        }
    } catch (err) {
        return `URL is malformed: ${UnknownError.cast(err).message}`
    }
}
