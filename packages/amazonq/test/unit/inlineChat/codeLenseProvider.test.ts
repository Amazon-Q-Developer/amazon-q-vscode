/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as vscode from 'vscode'
import { FakeExtensionContext } from 'aws-core-vscode/test'
import { CodelensProvider } from '../../../src/inlineChat/codeLenses/codeLenseProvider'
import { InlineTask, TaskState } from '../../../src/inlineChat/controller/inlineTask'

describe('inline chat CodelensProvider', function () {
    let provider: CodelensProvider
    const token = new vscode.CancellationTokenSource().token
    const uriA = vscode.Uri.parse('file:///tmp/a.ts')
    const uriB = vscode.Uri.parse('file:///tmp/b.ts')

    // Lightweight stand-in for an InlineTask exposing only the fields updateLenses reads.
    function makeTask(uri: vscode.Uri, state: TaskState): InlineTask {
        return {
            state,
            selectedRange: new vscode.Range(0, 0, 0, 0),
            document: { uri } as vscode.TextDocument,
        } as unknown as InlineTask
    }

    function docFor(uri: vscode.Uri): vscode.TextDocument {
        return { uri } as vscode.TextDocument
    }

    beforeEach(async function () {
        provider = new CodelensProvider(await FakeExtensionContext.create())
    })

    it('shows accept/reject lenses only in the task document, not other files', function () {
        provider.updateLenses(makeTask(uriA, TaskState.WaitingForDecision))

        // The document that owns the task shows the two decision lenses.
        assert.strictEqual(provider.provideCodeLenses(docFor(uriA), token).length, 2)
        // Switching to another file must not surface the lenses (regression guard).
        assert.strictEqual(provider.provideCodeLenses(docFor(uriB), token).length, 0)
    })

    it('shows the in-progress lens only in the task document', function () {
        provider.updateLenses(makeTask(uriA, TaskState.InProgress))

        assert.strictEqual(provider.provideCodeLenses(docFor(uriA), token).length, 1)
        assert.strictEqual(provider.provideCodeLenses(docFor(uriB), token).length, 0)
    })

    it('clears the lenses once the task completes', function () {
        provider.updateLenses(makeTask(uriA, TaskState.WaitingForDecision))
        provider.updateLenses(makeTask(uriA, TaskState.Complete))

        assert.strictEqual(provider.provideCodeLenses(docFor(uriA), token).length, 0)
    })
})
