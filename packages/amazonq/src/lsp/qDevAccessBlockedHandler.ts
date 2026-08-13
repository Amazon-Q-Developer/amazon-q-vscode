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

/** MessageType.Error from the LSP spec. */
const messageTypeError = 1

/**
 * Title the language server sets on the access-blocked notification.
 *
 * See the fallback discussion on {@link isQDevAccessBlockedNotification}.
 */
const qDevNotificationTitle = 'Amazon Q Developer'

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
 * Whether this notification is Amazon Q Developer reporting that it has blocked access for the
 * current identity.
 *
 * Matches on `id` when present. The title fallback exists because the currently released language
 * server sends this notification without an `id`, leaving the error type and title as the only
 * available discriminators. The fallback should be removed once a server carrying the id is the
 * minimum supported version -- it is deliberately narrow (exact title AND error severity) so it
 * cannot swallow unrelated notifications in the meantime.
 */
function isQDevAccessBlockedNotification(params: ShowNotificationParams): boolean {
    if (params.id === qDevAccessBlockedNotificationId) {
        return true
    }
    return params.type === messageTypeError && params.content?.title === qDevNotificationTitle
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
