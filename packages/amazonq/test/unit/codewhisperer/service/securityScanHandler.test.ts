/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PromiseResult } from 'aws-sdk/lib/request'
import { getTestLogger, Stub, stub, TestFolder } from 'aws-core-vscode/test'
import { AWSError, HttpResponse } from 'aws-sdk'
import {
    CodeAnalysisScope,
    RawCodeScanIssue,
    listScanResults,
    mapToAggregatedList,
    DefaultCodeWhispererClient,
    ListCodeScanFindingsResponse,
    pollScanJobStatus,
    resolveCodeScanFindingPath,
    SecurityScanTimedOutError,
    CodeWhispererConstants,
    CodeScansState,
} from 'aws-core-vscode/codewhisperer'
import { timeoutUtils } from 'aws-core-vscode/shared'
import assert from 'assert'
import sinon from 'sinon'
import * as vscode from 'vscode'
import path from 'path'
import { symlinkSync } from 'fs' // eslint-disable-line no-restricted-imports

const buildRawCodeScanIssue = (params?: Partial<RawCodeScanIssue>): RawCodeScanIssue => ({
    filePath: 'workspaceFolder/python3.7-plain-sam-app/hello_world/app.py',
    startLine: 1,
    endLine: 1,
    title: 'title',
    description: {
        text: 'text',
        markdown: 'markdown',
    },
    detectorId: 'detectorId',
    detectorName: 'detectorName',
    findingId: 'findingId',
    relatedVulnerabilities: [],
    severity: 'High',
    remediation: {
        recommendation: {
            text: 'text',
            url: 'url',
        },
        suggestedFixes: [],
    },
    codeSnippet: [],
    ...params,
})

const buildMockListCodeScanFindingsResponse = (
    codeScanFindings: string = JSON.stringify([buildRawCodeScanIssue()]),
    nextToken?: boolean
): Awaited<Promise<PromiseResult<ListCodeScanFindingsResponse, AWSError>>> => ({
    $response: {
        hasNextPage: () => false,
        nextPage: () => null, // eslint-disable-line unicorn/no-null
        data: undefined,
        error: undefined,
        requestId: '',
        redirectCount: 0,
        retryCount: 0,
        httpResponse: new HttpResponse(),
    },
    codeScanFindings,
    nextToken: nextToken ? 'nextToken' : undefined,
})

function getWorkspaceFolder(): string {
    return (
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        path.join(__dirname, '../../../../../../core/src/testFixtures/workspaceFolder')
    )
}

describe('securityScanHandler', function () {
    describe('listScanResults', function () {
        let mockClient: Stub<DefaultCodeWhispererClient>
        beforeEach(function () {
            mockClient = stub(DefaultCodeWhispererClient)
        })

        it('should make ListCodeScanFindings request and aggregate findings by file path', async function () {
            mockClient.listCodeScanFindings.resolves(buildMockListCodeScanFindingsResponse())

            const aggregatedCodeScanIssueList = await listScanResults(
                mockClient,
                'jobId',
                'codeScanFindingsSchema',
                [getWorkspaceFolder()],
                CodeAnalysisScope.PROJECT,
                undefined
            )

            assert.equal(aggregatedCodeScanIssueList.length, 1)
            assert.equal(aggregatedCodeScanIssueList[0].issues.length, 1)
        })

        it('should handle ListCodeScanFindings request with paginated response', async function () {
            mockClient.listCodeScanFindings
                .onFirstCall()
                .resolves(
                    buildMockListCodeScanFindingsResponse(
                        JSON.stringify([buildRawCodeScanIssue({ title: 'title1' })]),
                        true
                    )
                )
                .onSecondCall()
                .resolves(
                    buildMockListCodeScanFindingsResponse(
                        JSON.stringify([buildRawCodeScanIssue({ title: 'title2' })]),
                        true
                    )
                )
                .onThirdCall()
                .resolves(
                    buildMockListCodeScanFindingsResponse(
                        JSON.stringify([buildRawCodeScanIssue({ title: 'title3' })]),
                        false
                    )
                )

            const aggregatedCodeScanIssueList = await listScanResults(
                mockClient,
                'jobId',
                'codeScanFindingsSchema',
                [getWorkspaceFolder()],
                CodeAnalysisScope.PROJECT,
                undefined
            )

            assert.equal(aggregatedCodeScanIssueList.length, 1)
            assert.equal(aggregatedCodeScanIssueList[0].issues.length, 3)
        })

        it('should set autoDetected based on scope', async function () {
            mockClient.listCodeScanFindings.resolves(
                buildMockListCodeScanFindingsResponse(JSON.stringify([buildRawCodeScanIssue()]))
            )
            for (const [scope, expectedValue] of [
                [CodeAnalysisScope.FILE_AUTO, true],
                [CodeAnalysisScope.FILE_ON_DEMAND, false],
                [CodeAnalysisScope.PROJECT, false],
            ] as [CodeAnalysisScope, boolean][]) {
                const aggregatedCodeScanIssueList = await listScanResults(
                    mockClient,
                    'jobId',
                    'codeScanFindingsSchema',
                    [getWorkspaceFolder()],
                    scope,
                    undefined
                )
                assert.ok(
                    aggregatedCodeScanIssueList.every((item) =>
                        item.issues.every((issue) => issue.autoDetected === expectedValue)
                    )
                )
            }
        })

        for (const [scope, projectPaths, usesAbsoluteFindingPath] of [
            [CodeAnalysisScope.FILE_AUTO, [], true],
            [CodeAnalysisScope.FILE_ON_DEMAND, [getWorkspaceFolder()], false],
        ] as const) {
            it(`maps an exact scanned file outside the workspace for ${scope}`, async function () {
                const testFolder = await TestFolder.create()
                const filePath = await testFolder.write('standalone.py', 'print("hello")')
                const findingPath = usesAbsoluteFindingPath
                    ? filePath
                    : filePath.slice(path.parse(filePath).root.length)
                const document = await vscode.workspace.openTextDocument(filePath)
                mockClient.listCodeScanFindings.resolves(
                    buildMockListCodeScanFindingsResponse(
                        JSON.stringify([
                            buildRawCodeScanIssue({
                                filePath: findingPath,
                                codeSnippet: [{ number: 1, content: 'print("hello")' }],
                            }),
                        ])
                    )
                )

                const result = await listScanResults(
                    mockClient,
                    'jobId',
                    'codeScanFindingsSchema',
                    [...projectPaths],
                    scope,
                    { document } as vscode.TextEditor
                )

                assert.strictEqual(result.length, 1)
                assert.strictEqual(result[0].filePath, filePath)
            })
        }

        it('does not map an exact editor file outside the workspace for a project scan', async function () {
            const testFolder = await TestFolder.create()
            const filePath = await testFolder.write('outside.py')
            const findingPath = filePath.slice(path.parse(filePath).root.length)
            const document = await vscode.workspace.openTextDocument(filePath)
            const previousWarnings = getTestLogger().getLoggedEntries('warn').length
            mockClient.listCodeScanFindings.resolves(
                buildMockListCodeScanFindingsResponse(
                    JSON.stringify([buildRawCodeScanIssue({ filePath: findingPath })])
                )
            )

            const result = await listScanResults(
                mockClient,
                'jobId',
                'codeScanFindingsSchema',
                [getWorkspaceFolder()],
                CodeAnalysisScope.PROJECT,
                { document } as vscode.TextEditor
            )

            assert.deepStrictEqual(result, [])
            assert.strictEqual(
                getTestLogger().getLoggedEntries('warn')[previousWarnings],
                `Ignoring code scan findings for a path that does not map to a scanned project: ${findingPath}`
            )
        })
    })

    describe('resolveCodeScanFindingPath', function () {
        let testFolder: TestFolder
        let projectPath: string
        let projectFilePath: string
        let outsideFilePath: string

        beforeEach(async function () {
            testFolder = await TestFolder.create()
            projectPath = await testFolder.mkdir('project')
            projectFilePath = await testFolder.write('project/src/app.py')
            outsideFilePath = await testFolder.write('outside.py')
        })

        it('maps a finding to a file in the scanned project', function () {
            const findingPath = path.join(path.basename(projectPath), 'src', 'app.py')

            assert.strictEqual(resolveCodeScanFindingPath([projectPath], findingPath), projectFilePath)
        })

        it('rejects a path that traverses outside the scanned project', function () {
            const findingPath = path.join(path.basename(projectPath), '..', path.basename(outsideFilePath))

            assert.strictEqual(resolveCodeScanFindingPath([projectPath], findingPath), undefined)
        })

        it('rejects a path with Windows separators that traverses outside the scanned project', function () {
            const findingPath = `${path.basename(projectPath)}\\..\\${path.basename(outsideFilePath)}`

            assert.strictEqual(resolveCodeScanFindingPath([projectPath], findingPath), undefined)
        })

        it('rejects an absolute path outside the scanned project', function () {
            assert.strictEqual(resolveCodeScanFindingPath([projectPath], outsideFilePath), undefined)
        })

        it('rejects a path in a sibling directory with the same prefix', async function () {
            const siblingPath = `${path.basename(projectPath)}-other`
            await testFolder.write(`${siblingPath}/app.py`)

            assert.strictEqual(resolveCodeScanFindingPath([projectPath], `${siblingPath}/app.py`), undefined)
        })

        it('rejects a symlink to a file outside the scanned projects', function () {
            if (process.platform === 'win32') {
                this.skip()
            }

            const symlinkPath = path.join(projectPath, 'outside.py')
            symlinkSync(outsideFilePath, symlinkPath)

            assert.strictEqual(
                resolveCodeScanFindingPath([projectPath], `${path.basename(projectPath)}/outside.py`),
                undefined
            )
        })

        it('allows a symlink to a file in another scanned project', async function () {
            if (process.platform === 'win32') {
                this.skip()
            }

            const otherProjectPath = await testFolder.mkdir('other-project')
            const otherProjectFilePath = await testFolder.write('other-project/app.py')
            const symlinkPath = path.join(projectPath, 'other.py')
            symlinkSync(otherProjectFilePath, symlinkPath)

            assert.strictEqual(
                resolveCodeScanFindingPath([projectPath, otherProjectPath], `${path.basename(projectPath)}/other.py`),
                symlinkPath
            )
        })
    })

    describe('mapToAggregatedList', () => {
        let codeScanIssueMap: Map<string, RawCodeScanIssue[]>
        let editor: vscode.TextEditor | undefined

        beforeEach(() => {
            codeScanIssueMap = new Map()
            editor = {
                document: {
                    lineAt: (lineNumber: number): vscode.TextLine => ({
                        lineNumber: lineNumber + 1,
                        range: new vscode.Range(0, 0, 0, 0),
                        rangeIncludingLineBreak: new vscode.Range(0, 0, 0, 0),
                        firstNonWhitespaceCharacterIndex: 0,
                        isEmptyOrWhitespace: false,
                        text: `line ${lineNumber + 1}`,
                    }),
                },
            } as vscode.TextEditor
        })

        it('should aggregate issues by file path', () => {
            const json = JSON.stringify([
                {
                    filePath: 'file1.ts',
                    startLine: 1,
                    endLine: 2,
                    codeSnippet: [
                        { number: 1, content: 'line 1' },
                        { number: 2, content: 'line 2' },
                    ],
                },
                { filePath: 'file2.ts', startLine: 1, endLine: 1, codeSnippet: [{ number: 1, content: 'line 1' }] },
            ])

            mapToAggregatedList(codeScanIssueMap, json, editor, CodeAnalysisScope.FILE_AUTO)

            assert.equal(codeScanIssueMap.size, 2)
            assert.equal(codeScanIssueMap.get('file1.ts')?.length, 1)
            assert.equal(codeScanIssueMap.get('file2.ts')?.length, 1)
        })

        it('should filter issues based on the scope', () => {
            const json = JSON.stringify([
                {
                    filePath: 'file1.ts',
                    startLine: 1,
                    endLine: 2,
                    codeSnippet: [
                        { number: 1, content: 'line 1' },
                        { number: 2, content: 'line 2' },
                    ],
                },
                { filePath: 'file1.ts', startLine: 3, endLine: 3, codeSnippet: [{ number: 3, content: 'line 3' }] },
            ])

            mapToAggregatedList(codeScanIssueMap, json, editor, CodeAnalysisScope.FILE_AUTO)

            assert.equal(codeScanIssueMap.size, 1)
            assert.equal(codeScanIssueMap.get('file1.ts')?.length, 2)
        })

        it('should handle issue filtering with redacted code', () => {
            const json = JSON.stringify([
                {
                    filePath: 'file1.ts',
                    startLine: 1,
                    endLine: 2,
                    codeSnippet: [
                        { number: 1, content: '**** *' },
                        { number: 2, content: '**** *' },
                    ],
                },
                { filePath: 'file1.ts', startLine: 3, endLine: 3, codeSnippet: [{ number: 3, content: '**** **' }] },
            ])

            mapToAggregatedList(codeScanIssueMap, json, editor, CodeAnalysisScope.FILE_AUTO)
            assert.strictEqual(codeScanIssueMap.size, 1)
            assert.strictEqual(codeScanIssueMap.get('file1.ts')?.length, 1)
        })

        it('should handle duplicate issues', function () {
            const json = JSON.stringify([
                {
                    filePath: 'file1.ts',
                    startLine: 1,
                    endLine: 2,
                    title: 'duplicate issue',
                    codeSnippet: [
                        { number: 1, content: 'line 1' },
                        { number: 2, content: 'line 2' },
                    ],
                },
                {
                    filePath: 'file1.ts',
                    startLine: 1,
                    endLine: 2,
                    title: 'duplicate issue',
                    codeSnippet: [
                        { number: 1, content: 'line 1' },
                        { number: 2, content: 'line 2' },
                    ],
                },
            ])

            mapToAggregatedList(codeScanIssueMap, json, editor, CodeAnalysisScope.FILE_AUTO)
            assert.strictEqual(codeScanIssueMap.size, 1)
            assert.strictEqual(codeScanIssueMap.get('file1.ts')?.length, 1)
        })
    })

    describe('pollScanJobStatus', function () {
        let mockClient: Stub<DefaultCodeWhispererClient>
        let clock: sinon.SinonFakeTimers
        const mockJobId = 'test-job-id'
        const mockStartTime = Date.now()

        beforeEach(function () {
            mockClient = stub(DefaultCodeWhispererClient)
            clock = sinon.useFakeTimers({
                shouldAdvanceTime: true,
            })
            sinon.stub(timeoutUtils, 'sleep').resolves()
            sinon.stub(CodeScansState.instance, 'isScansEnabled').returns(true)
        })

        afterEach(function () {
            sinon.restore()
            clock.restore()
        })

        it('should return status when scan completes successfully', async function () {
            mockClient.getCodeScan
                .onFirstCall()
                .resolves({ status: 'Pending', $response: { requestId: 'req1' } })
                .onSecondCall()
                .resolves({ status: 'Completed', $response: { requestId: 'req2' } })

            const result = await pollScanJobStatus(mockClient, mockJobId, CodeAnalysisScope.FILE_AUTO, mockStartTime)
            assert.strictEqual(result, 'Completed')
        })

        it('should throw SecurityScanTimedOutError when polling exceeds timeout for express scans', async function () {
            mockClient.getCodeScan.resolves({ status: 'Pending', $response: { requestId: 'req1' } })

            const pollPromise = pollScanJobStatus(mockClient, mockJobId, CodeAnalysisScope.FILE_AUTO, mockStartTime)

            const expectedTimeoutMs = CodeWhispererConstants.expressScanTimeoutMs
            clock.tick(expectedTimeoutMs + 1000)

            await assert.rejects(() => pollPromise, SecurityScanTimedOutError)
        })

        it('should throw SecurityScanTimedOutError when polling exceeds timeout for standard scans', async function () {
            mockClient.getCodeScan.resolves({ status: 'Pending', $response: { requestId: 'req1' } })

            const pollPromise = pollScanJobStatus(mockClient, mockJobId, CodeAnalysisScope.PROJECT, mockStartTime)

            const expectedTimeoutMs = CodeWhispererConstants.standardScanTimeoutMs
            clock.tick(expectedTimeoutMs + 1000)

            await assert.rejects(() => pollPromise, SecurityScanTimedOutError)
        })
    })
})
