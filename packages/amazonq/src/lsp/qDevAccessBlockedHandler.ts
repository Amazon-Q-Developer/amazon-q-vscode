/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { LanguageClient } from 'vscode-languageclient/node'
import { getLogger } from 'aws-core-vscode/shared'
import { AuthUtil, setQDevAccessBlocked } from 'aws-core-vscode/codewhisperer'

/**
 * Method the language server uses to push notifications to the client.
 *
 * Hard-coded rather than imported from `@aws/language-server-runtimes/protocol` so that the
 * extension does not take a new dependency on the runtimes package purely for a string constant.
 */
const showNotificationMethod = 'aws/window/showNotification'

/**
 * Stable identifier the language server is expected to set on the access-blocked notification.
 *
 * Preferred over any text matching, because it is the only part of the payload that is meant to be
 * machine-readable.
 */
const qDevAccessBlockedNotificationId = 'qDevPluginAccessBlocked'

interface ShowNotificationParams {
    id?: string
    type?: number
    content?: {
        title?: string
        text?: string
    }
}

/**
 * The id the server set, recovered from what the client actually receives.
 *
 * The runtime does not forward the server's id verbatim: `RouterByServerName` replaces it with
 * base64 of `{"serverName":...,"id":...}` so that followups can be routed back to the originating
 * server. The server's own id is therefore only reachable by decoding that envelope.
 *
 * Returns the raw value when it is not an envelope, so a server that sends a plain id still matches.
 */
function serverNotificationId(id: string | undefined): string | undefined {
    if (id === undefined) {
        return undefined
    }

    try {
        const decoded = JSON.parse(Buffer.from(id, 'base64').toString('utf-8')) as { id?: unknown }
        if (typeof decoded.id === 'string') {
            return decoded.id
        }
    } catch {
        // Not an envelope; fall through to treating the value as the id itself.
    }

    return id
}

/**
 * Whether this notification is Amazon Q Developer reporting that it has blocked access for the
 * current identity.
 *
 * Matches on the id only. Matching on the title was tried and rejected: acting on this notification
 * signs the user out, and 'Amazon Q Developer' is a plausible title for any future error the server
 * sends, so a text match would eventually sign out a working user. Every server able to deliver a
 * notification at all sends the id, so there is nothing to fall back for.
 */
function isQDevAccessBlockedNotification(params: ShowNotificationParams): boolean {
    return serverNotificationId(params.id) === qDevAccessBlockedNotificationId
}

/**
 * Reacts to the language server reporting that Amazon Q Developer has blocked this identity.
 *
 * The server detects this because RTS gates Q Developer plugin traffic before the activity runs, so
 * every request from a blocked identity is denied -- including the ones the extension itself never
 * makes. Detection therefore has to come from the server; the extension's own service calls are not
 * covered by the gate and succeed even for a blocked identity.
 *
 * On detection the blocked state is persisted and the user is signed out. Persisting first matters:
 * signing out clears the connection, which is what makes the login view render, and the stored
 * message is what that view then displays. Doing it the other way round loses the explanation.
 */
export function registerQDevAccessBlockedHandler(client: LanguageClient) {
    client.onNotification(showNotificationMethod, async (params: ShowNotificationParams) => {
        try {
            if (!isQDevAccessBlockedNotification(params)) {
                return
            }

            const message = params.content?.text?.trim()
            if (message === undefined || message.length === 0) {
                getLogger().warn('qDevAccessBlocked: notification had no message, ignoring')
                return
            }

            await setQDevAccessBlocked(message)
            // Refresh first so the login view is already showing by the time the connection goes
            // away, then sign out. The persisted flag keeps the blocked screen selected afterwards.
            await AuthUtil.instance.setVscodeContextProps()
            await AuthUtil.instance.secondaryAuth.deleteConnection()
        } catch (e) {
            // Never let this throw: it runs on the language client's notification dispatch, and a
            // failure here must not disturb the rest of the connection.
            getLogger().error('qDevAccessBlocked: failed to handle notification: %s', (e as Error)?.message)
        }
    })
}
