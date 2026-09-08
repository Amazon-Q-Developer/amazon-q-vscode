/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionContext } from 'vscode'
import { activateWebShared } from 'aws-core-vscode/webShared'
import { showWebModeUnsupportedMessageOnce } from 'aws-core-vscode/amazonq'
import { activateAmazonQCommon, deactivateCommon } from './extension'

export async function activate(context: ExtensionContext) {
    await activateWebShared(context)
    await activateAmazonQCommon(context, true)
    // Amazon Q needs a Node.js extension host (desktop VS Code, or a browser editor connected to a
    // remote environment). In the browser-only extension host the language server cannot start, so
    // tell the user up front instead of letting them click "Sign in" and see nothing happen.
    showWebModeUnsupportedMessageOnce()
}

export async function deactivate() {
    await deactivateCommon()
}
