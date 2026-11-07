/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { CodeScanIssue } from '../models/model'
import globals from '../../shared/extensionGlobals'
import { telemetry } from '../../shared/telemetry/telemetry'
import path from 'path'
import { AuthUtil } from '../util/authUtil'
import { TelemetryHelper } from '../util/telemetryHelper'
import { SecurityIssueProvider } from './securityIssueProvider'

/** The only commands the hover links to; command links to anything else are not run. */
const hoverCommandIds = [
    'aws.amazonq.explainIssue',
    'aws.amazonq.generateFix',
    'aws.amazonq.security.ignore',
    'aws.amazonq.security.ignoreAll',
] as const

export class SecurityIssueHoverProvider implements vscode.HoverProvider {
    static #instance: SecurityIssueHoverProvider
    private issueProvider: SecurityIssueProvider = SecurityIssueProvider.instance

    public static get instance() {
        return (this.#instance ??= new this())
    }

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover {
        const contents: vscode.MarkdownString[] = []

        for (const group of this.issueProvider.issues) {
            if (document.fileName !== group.filePath) {
                continue
            }

            for (const issue of group.issues) {
                if (!issue.visible) {
                    continue
                }
                const range = new vscode.Range(issue.startLine, 0, issue.endLine, 0)
                if (range.contains(position)) {
                    contents.push(this._getContent(group.filePath, issue))
                    telemetry.codewhisperer_codeScanIssueHover.emit({
                        findingId: issue.findingId,
                        detectorId: issue.detectorId,
                        ruleId: issue.ruleId,
                        includesFix: !!issue.suggestedFixes.length,
                        credentialStartUrl: AuthUtil.instance.startUrl,
                        autoDetected: issue.autoDetected,
                    })
                    TelemetryHelper.instance.sendCodeScanRemediationsEvent(
                        document.languageId,
                        'CODESCAN_ISSUE_HOVER',
                        issue.detectorId,
                        issue.findingId,
                        issue.ruleId,
                        undefined,
                        undefined,
                        undefined,
                        !!issue.suggestedFixes.length
                    )
                }
            }
        }

        return new vscode.Hover(contents)
    }

    private _getContent(filePath: string, issue: CodeScanIssue) {
        const markdownString = new vscode.MarkdownString()
        markdownString.isTrusted = { enabledCommands: [...hoverCommandIds] }
        markdownString.supportThemeIcons = true
        markdownString.baseUri = vscode.Uri.file(path.join(globals.context.extensionPath, 'resources/images/'))

        const [suggestedFix] = issue.suggestedFixes

        // Finding text is appended as plain text so it cannot add links, images or HTML to the hover.
        markdownString.appendMarkdown('## ')
        markdownString.appendText(issue.title)
        markdownString.appendMarkdown(` ${this._makeSeverityBadge(issue.severity)}\n`)
        markdownString.appendText(
            suggestedFix?.code && suggestedFix.description !== '' ? suggestedFix.description : issue.recommendation.text
        )
        markdownString.appendMarkdown('\n\n')

        const explainWithQCommand = this._getCommandMarkdown(
            'aws.amazonq.explainIssue',
            [issue, filePath],
            'comment',
            'Explain',
            'Explain with Amazon Q'
        )
        markdownString.appendMarkdown(explainWithQCommand)

        const generateFixCommand = this._getCommandMarkdown(
            'aws.amazonq.generateFix',
            [issue, filePath],
            'wrench',
            'Fix',
            'Fix with Amazon Q'
        )
        markdownString.appendMarkdown(' | ' + generateFixCommand)

        const ignoreIssueCommand = this._getCommandMarkdown(
            'aws.amazonq.security.ignore',
            [issue, filePath, 'hover'],
            'error',
            'Ignore',
            'Ignore Issue'
        )
        markdownString.appendMarkdown(' | ' + ignoreIssueCommand)

        const ignoreSimilarIssuesCommand = this._getCommandMarkdown(
            'aws.amazonq.security.ignoreAll',
            [issue, 'hover'],
            'error',
            'Ignore All',
            'Ignore Similar Issues'
        )
        markdownString.appendMarkdown(' | ' + ignoreSimilarIssuesCommand)

        return markdownString
    }

    private _getCommandMarkdown(command: string, args: any, icon: string, text: string, description: string) {
        const commandUri = vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify(args))}`)
        return `[$(${icon}) ${text}](${commandUri} '${description}')\n`
    }

    private _makeSeverityBadge(severity: string) {
        if (!severity) {
            return ''
        }
        return `![${severity}](severity-${severity.toLowerCase()}.svg)`
    }
}
