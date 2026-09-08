/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { showMessage } from '../shared/utilities/messages'
import { once } from '../shared/utilities/functionUtils'

/**
 * Amazon Q depends on the Amazon Q language server, which runs as a Node.js child process.
 * The browser-only VS Code extension host (for example vscode.dev or github.dev opened without
 * a remote/backend environment) cannot spawn processes, so Amazon Q features cannot work there.
 *
 * Users end up with an extension that appears installed but does nothing when they click "Sign in".
 * This message tells them why, and what to do instead.
 */
export const webModeUnsupportedMessage =
    'Amazon Q is not available in the browser-only version of VS Code (for example vscode.dev or github.dev without a remote environment). ' +
    'Use VS Code on your desktop, or connect the browser editor to a remote environment such as a codespace or a remote host, to use Amazon Q.'

/**
 * Shows a non-modal notification explaining that Amazon Q does not work in the browser-only extension host.
 */
export function showWebModeUnsupportedMessage(): Thenable<string | undefined> {
    return showMessage('info', webModeUnsupportedMessage, [], {}, { id: 'amazonqWebModeUnsupported' })
}

/**
 * Same as {@link showWebModeUnsupportedMessage}, but only shows the notification once per session.
 * Intended for extension activation so the notification is not repeated.
 */
export const showWebModeUnsupportedMessageOnce = once(() => {
    void showWebModeUnsupportedMessage()
})
