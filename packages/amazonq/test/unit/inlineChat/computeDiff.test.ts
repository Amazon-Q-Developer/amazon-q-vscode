/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as vscode from 'vscode'
import { createMockDocument } from 'aws-core-vscode/test'
import { InlineTask, TextDiff } from '../../../src/inlineChat/controller/inlineTask'
import { anchorResponseToDocument, computeDiff } from '../../../src/inlineChat/output/computeDiff'

function createTask(content: string, selection: vscode.Selection): InlineTask {
    return new InlineTask('query', createMockDocument(content), selection)
}

function cursorAt(line: number, character = 0): vscode.Selection {
    return new vscode.Selection(line, character, line, character)
}

function insertions(diff: TextDiff[] | undefined) {
    return (diff ?? []).filter((d): d is Extract<TextDiff, { type: 'insertion' }> => d.type === 'insertion')
}

function deletions(diff: TextDiff[] | undefined) {
    return (diff ?? []).filter((d): d is Extract<TextDiff, { type: 'deletion' }> => d.type === 'deletion')
}

describe('inlineChat computeDiff', function () {
    const source = [
        'class Foo:',
        '    def bar(self):',
        '        x = 1',
        '',
        '        return x',
        '',
        'def baz():',
        '    pass',
        '',
    ].join('\n')

    describe('anchorResponseToDocument', function () {
        it('widens an empty selection to the surrounding lines echoed by the response', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['    def bar(self):', '        x = 1', '        y = 2', '        return x'].join('\n')

            const anchored = anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 1)
            assert.strictEqual(task.selectedRange.end.line, 4)
            assert.strictEqual(
                task.selectedText,
                ['    def bar(self):', '        x = 1', '', '        return x'].join('\n')
            )
            assert.strictEqual(anchored, response)
        })

        it('re-indents the response to line up with the anchored document lines', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['def bar(self):', '    x = 1', '    y = 2', '', '    return x'].join('\n')

            const anchored = anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 1)
            assert.strictEqual(task.selectedRange.end.line, 4)
            assert.strictEqual(
                anchored,
                ['    def bar(self):', '        x = 1', '        y = 2', '', '        return x'].join('\n')
            )
        })

        it('anchors on only one side when the response echoes only lines above the selection', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['        x = 1', '        y = 2'].join('\n')

            anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 2)
            assert.strictEqual(task.selectedRange.end.line, 3)
        })

        it('anchors on only one side when the response echoes only lines below the selection', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['        y = 2', '        return x'].join('\n')

            anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 3)
            assert.strictEqual(task.selectedRange.end.line, 4)
        })

        it('leaves the selection untouched when the response does not repeat surrounding code', function () {
            const task = createTask(source, cursorAt(3))
            const response = '        y = 2'

            const anchored = anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 3)
            assert.strictEqual(task.selectedRange.end.line, 3)
            assert.strictEqual(anchored, response)
        })

        it('ignores leading and trailing blank lines in the response when anchoring', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['', '    def bar(self):', '        x = 1', '        y = 2', '        return x', ''].join(
                '\n'
            )

            anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 1)
            assert.strictEqual(task.selectedRange.end.line, 4)
        })

        it('widens a non-empty selection when the response repeats the enclosing block', function () {
            const task = createTask(source, new vscode.Selection(2, 0, 2, 13))
            const response = ['    def bar(self):', '        x = 10', '', '        return x'].join('\n')

            anchorResponseToDocument(response, task)

            assert.strictEqual(task.selectedRange.start.line, 1)
            assert.strictEqual(task.selectedRange.end.line, 4)
        })
    })

    describe('computeDiff', function () {
        it('only inserts the new code when the response echoes the enclosing method', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['    def bar(self):', '        x = 1', '        y = 2', '        return x'].join('\n')

            const diff = computeDiff(response, task, false)

            const added = insertions(diff)
            assert.strictEqual(added.length, 1)
            assert.strictEqual(added[0].replacementText, '        y = 2\n')
            assert.strictEqual(added[0].range.start.line, 4)
            assert.strictEqual(deletions(diff).length, 0)
        })

        it('inserts the response at the cursor when nothing is echoed', function () {
            const task = createTask(source, cursorAt(3))

            const diff = computeDiff('        y = 2', task, false)

            const added = insertions(diff)
            assert.strictEqual(added.length, 1)
            assert.strictEqual(added[0].replacementText, '        y = 2')
            assert.strictEqual(added[0].range.start.line, 3)
        })

        it('keeps the indentation of every response line when the selection is empty', function () {
            const task = createTask(source, cursorAt(3))
            const response = ['        if x:', '            x += 1'].join('\n')

            const diff = computeDiff(response, task, false)

            const added = insertions(diff)
            assert.strictEqual(added.length, 1)
            assert.strictEqual(added[0].replacementText, '        if x:\n            x += 1')
        })

        it('does not anchor partial responses', function () {
            const task = createTask(source, cursorAt(3))
            task.partialSelectedText = ''
            const response = ['    def bar(self):', '        x = 1'].join('\n')

            computeDiff(response, task, true)

            assert.strictEqual(task.selectedRange.start.line, 3)
            assert.strictEqual(task.selectedRange.end.line, 3)
        })
    })
})
