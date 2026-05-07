/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ArrayConstructor } from '../../shared/utilities/typeConstructors'
import { fromExtensionManifest, migrateSetting } from '../../shared/settings'

const description = {
    showCodeWithReferences: Boolean,
    importRecommendationForInlineCodeSuggestions: Boolean, // eslint-disable-line id-length
    shareContentWithAWS: Boolean,
    workspaceIndexMaxSize: Number,
    workspaceIndexMaxFileSize: Number,
    workspaceIndexIgnoreFilePatterns: ArrayConstructor(String),
    ignoredSecurityIssues: ArrayConstructor(String),
}

export class CodeWhispererSettings extends fromExtensionManifest('amazonQ', description) {
    // TODO: Remove after a few releases
    public async importSettings() {
        await migrateSetting(
            { key: 'amazonQ.showInlineCodeSuggestionsWithCodeReferences', type: Boolean },
            { key: 'amazonQ.showCodeWithReferences' }
        )
    }
    public isSuggestionsWithCodeReferencesEnabled(): boolean {
        return this.get(`showCodeWithReferences`, false)
    }
    public isImportRecommendationEnabled(): boolean {
        return this.get(`importRecommendationForInlineCodeSuggestions`, false)
    }

    public isOptoutEnabled(): boolean {
        const value = this.get('shareContentWithAWS', true)
        return !value
    }
    public getIgnoredSecurityIssues(): string[] {
        return this.get('ignoredSecurityIssues', [])
    }

    public getMaxIndexSize(): number {
        // minimal 1MB
        return Math.max(this.get('workspaceIndexMaxSize', 2048), 1)
    }

    public getMaxIndexFileSize(): number {
        // minimal 1MB
        return Math.max(this.get('workspaceIndexMaxFileSize', 10), 1)
    }

    public getIndexIgnoreFilePatterns(): string[] {
        return this.get('workspaceIndexIgnoreFilePatterns', [])
    }

    public async addToIgnoredSecurityIssuesList(issueTitle: string) {
        await this.update('ignoredSecurityIssues', [...this.getIgnoredSecurityIssues(), issueTitle])
    }

    static #instance: CodeWhispererSettings

    public static get instance() {
        return (this.#instance ??= new this())
    }
}
