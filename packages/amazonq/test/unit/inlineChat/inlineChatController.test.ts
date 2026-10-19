/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as vscode from 'vscode'
import { shouldEnableInlineDecisionShortcut } from '../../../src/inlineChat/controller/inlineChatController'
import { InlineTask, TaskState } from '../../../src/inlineChat/controller/inlineTask'

function taskFor(uri: vscode.Uri, state: TaskState): Pick<InlineTask, 'state' | 'document'> {
    return {
        state,
        document: { uri } as vscode.TextDocument,
    }
}

function editorFor(uri: vscode.Uri): Pick<vscode.TextEditor, 'document'> {
    return { document: { uri } as vscode.TextDocument }
}

describe('inline chat decision shortcut focus', function () {
    const taskUri = vscode.Uri.parse('file:///tmp/task.ts')
    const otherUri = vscode.Uri.parse('file:///tmp/other.ts')

    it('enables the shortcut only when the waiting task document has focus', function () {
        const task = taskFor(taskUri, TaskState.WaitingForDecision)

        assert.strictEqual(shouldEnableInlineDecisionShortcut(task, editorFor(taskUri)), true)
        assert.strictEqual(shouldEnableInlineDecisionShortcut(task, editorFor(otherUri)), false)
        assert.strictEqual(shouldEnableInlineDecisionShortcut(task, undefined), false)
    })

    it('does not enable the shortcut for a non-waiting or missing task', function () {
        assert.strictEqual(
            shouldEnableInlineDecisionShortcut(taskFor(taskUri, TaskState.InProgress), editorFor(taskUri)),
            false
        )
        assert.strictEqual(shouldEnableInlineDecisionShortcut(undefined, editorFor(taskUri)), false)
    })
})
