/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as path from 'path'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { symlinkSync } from 'fs' // eslint-disable-line no-restricted-imports
import { listScanResults, resolveCodeScanFindingPath } from '../../codewhisperer/service/securityScanHandler'
import { CodeAnalysisScope, codeScanFindingsSchema } from '../../codewhisperer/models/constants'
import { TestFolder } from '../testUtil'
import { createClient } from './testUtil'

describe('securityScanHandler', function () {
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

    afterEach(function () {
        sinon.restore()
    })

    async function createClientWithFindingPath(findingPath: string) {
        const client = createClient()
        const response = await client.listCodeScanFindings(
            {
                jobId: 'jobId',
                codeAnalysisFindingsSchema: codeScanFindingsSchema,
            },
            undefined
        )
        assert.ok('codeScanFindings' in response)
        const findings = JSON.parse(response.codeScanFindings!)
        findings[0].filePath = findingPath
        response.codeScanFindings = JSON.stringify(findings)
        client.listCodeScanFindings.resolves(response)
        return client
    }

    it('opens a file in the scanned project from scan findings', async function () {
        const findingPath = `${path.basename(projectPath)}/src/app.py`
        const client = await createClientWithFindingPath(findingPath)

        const result = await listScanResults(
            client,
            'jobId',
            codeScanFindingsSchema,
            [projectPath],
            CodeAnalysisScope.PROJECT,
            undefined
        )

        assert.strictEqual(result.length, 1)
        assert.strictEqual(result[0].filePath, projectFilePath)
    })

    it('does not open a file outside the scanned project from scan findings', async function () {
        const client = await createClientWithFindingPath(outsideFilePath)
        const openTextDocument = sinon.spy(vscode.workspace, 'openTextDocument')

        const result = await listScanResults(
            client,
            'jobId',
            codeScanFindingsSchema,
            [projectPath],
            CodeAnalysisScope.PROJECT,
            undefined
        )

        assert.deepStrictEqual(result, [])
        assert.ok(openTextDocument.notCalled)
    })

    describe('resolveCodeScanFindingPath', function () {
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

        it('rejects a symlink to a file outside the scanned project', function () {
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
    })
})
