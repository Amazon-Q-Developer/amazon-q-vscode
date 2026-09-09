/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types that can be used by both the backend and frontend files
 */

/**
 * The identifiers for the different features that use Auth.
 *
 * These are important as they represent the specific feature for all parts of the
 * auth sign setup flows.
 */
export const FeatureIds = {
    TOOLKIT: 'TOOLKIT',
    AMAZONQ: 'AMAZONQ',
} as const
export type FeatureId = (typeof FeatureIds)[keyof typeof FeatureIds]

/**
 * The type of Auth flows that the user could see.
 */
export const AuthFlowStates = {
    /** User needs to select/setup a connection */
    LOGIN: 'LOGIN',
    /**  User has a connection but just needs to reauthenticate it */
    REAUTHNEEDED: 'REAUTHNEEDED',
    /**  Reauthentication is currently in progress */
    REAUTHENTICATING: 'REAUTHENTICATING',
    PENDING_PROFILE_SELECTION: 'PENDING_PROFILE_SELECTION',
} as const
export type AuthFlowState = (typeof AuthFlowStates)[keyof typeof AuthFlowStates]

export enum LoginOption {
    NONE,
    BUILDER_ID,
    CONSOLE_CREDENTIAL,
    ENTERPRISE_SSO,
    IAM_CREDENTIAL,
    IMPORTED_LOGINS,
}

/**
 * 'elementId' for auth telemetry
 */
export type AuthUiClick =
    | 'auth_backButton'
    | 'auth_cancelButton'
    | 'auth_reauthCancelButton'
    | 'auth_continueButton'
    | 'auth_idcOption'
    | 'auth_builderIdOption'
    | 'auth_credentialsOption'
    | 'auth_codecatalystOption'
    | 'auth_consoleCredentialsOption'
    | 'auth_existingAuthOption'
    | 'auth_regionSelection'
    | 'auth_codeCatalystSignIn'
    | 'auth_toolkitCloseButton'
    | 'auth_reauthenticate'
    | 'auth_signout'
    | 'auth_helpLink'
    | 'auth_go_back_not_accepting_new_customers'
    | 'amazonq_switchToQSignIn'

export const userCancelled = 'userCancelled'

/**
 * Sentinel prefix used by {@link listRegionProfiles} implementations to signal that the
 * returned error string represents Amazon Q Developer permanently rejecting this identity
 * (no longer accepting new customers), rather than a generic/transient failure. Frontend
 * code should strip this prefix before displaying the message, and render a "go back"
 * action instead of the usual retry/sign-out controls.
 *
 * Deliberately defined here (not in backend.ts) since this file has zero Node/vscode
 * dependencies and is safe to import as a runtime value from webview frontend bundles.
 * backend.ts pulls in `vscode`, `Auth`, etc. — importing a value from it (not just as a
 * TypeScript type) into a Vue frontend file bundles those Node-only dependencies into the
 * webview bundle, which crashes at load (blank webview) since none of them exist in a
 * webview's browser context.
 */
export const notAcceptingNewCustomersPrefix = '__Q_DEV_NOT_ACCEPTING_NEW_CUSTOMERS__:'

export type AuthEnabledFeatures = 'awsExplorer' | 'codewhisperer' | 'codecatalyst'

export type AuthError = { id: string; text: string }

export type ServiceItemId = 'awsExplorer' | 'codewhisperer' | 'codecatalyst'
export function isServiceItemId(value: unknown): value is ServiceItemId {
    return (
        typeof value === 'string' && (value === 'awsExplorer' || value === 'codewhisperer' || value === 'codecatalyst')
    )
}

export type AuthFormId =
    | 'credentials'
    | 'builderIdCodeWhisperer'
    | 'builderIdCodeCatalyst'
    | 'identityCenterCodeWhisperer'
    | 'identityCenterCodeCatalyst'
    | 'identityCenterExplorer'
    | 'unknown'
