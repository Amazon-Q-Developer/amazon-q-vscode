/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'
import { getLogger } from '../../shared/logger/logger'

/**
 * Persisted record that Amazon Q Developer has refused this identity.
 *
 * RTS gates Q Developer plugin traffic and denies Builder ID identities created on or after
 * 2026-07-25 with `AccessDeniedException` / `reason=FEATURE_NOT_SUPPORTED`. The language server
 * classifies that and tells us about it; we persist the fact so the UI can explain it.
 *
 * Persisted rather than held in memory for two reasons:
 *  1. Reacting to the rejection signs the user out, which tears down the in-memory auth state that
 *     would otherwise carry the message. Without persistence the explanation disappears at exactly
 *     the moment we need to show it.
 *  2. It must survive a window reload, otherwise reloading silently returns the user to a normal
 *     login screen with no idea why the previous attempt failed.
 */
const blockedKey = 'aws.amazonq.qDevAccessBlocked'

interface QDevAccessBlockedState {
    /**
     * The service's own message. Shown verbatim: `FEATURE_NOT_SUPPORTED` is reused across several
     * RTS gates, so the reason only tells us that access is denied -- the message is the only part
     * that says why and what the customer can do about it.
     */
    message: string
}

export function isQDevAccessBlocked(): boolean {
    return getQDevAccessBlockedMessage() !== undefined
}

export function getQDevAccessBlockedMessage(): string | undefined {
    const state = globals.globalState.get<QDevAccessBlockedState>(blockedKey)
    const message = state?.message
    return typeof message === 'string' && message.length > 0 ? message : undefined
}

export async function setQDevAccessBlocked(message: string): Promise<void> {
    getLogger().warn(`qDevAccessBlocked: Amazon Q Developer access is blocked for this identity`)
    await globals.globalState.update(blockedKey, { message } satisfies QDevAccessBlockedState)
}

/**
 * Clears the blocked state.
 *
 * This is the recovery path, and it is required rather than optional: without it a customer whose
 * account later becomes eligible -- or who was misclassified -- would be pinned to the blocked
 * screen with no way out short of wiping global state. Called when the user dismisses the screen so
 * they can attempt a different account.
 */
export async function clearQDevAccessBlocked(): Promise<void> {
    if (isQDevAccessBlocked()) {
        getLogger().debug('qDevAccessBlocked: clearing blocked state')
        await globals.globalState.update(blockedKey, undefined)
    }
}
