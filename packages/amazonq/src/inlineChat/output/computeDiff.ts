/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { type LinesOptions, diffLines } from 'diff'
import * as vscode from 'vscode'
import { InlineTask, TextDiff } from '../controller/inlineTask'

export function computeDiff(response: string, inlineTask: InlineTask, isPartialDiff: boolean): TextDiff[] | undefined {
    if (!response) {
        return
    }
    if (!isPartialDiff) {
        response = anchorResponseToDocument(response, inlineTask)
    }
    const selectedRange = inlineTask.selectedRange
    const partialSelectedText = inlineTask.partialSelectedText ?? ''
    const selectedText = isPartialDiff ? partialSelectedText : inlineTask.selectedText

    // With no selected code to align with (e.g. cursor on an empty line), keep the indentation the
    // response came with instead of re-basing its first line on the (empty) selection.
    const normalizedResponse =
        selectedText.trim() === ''
            ? trimBlankLines(response.split('\n')).join('\n')
            : getLeadingWhitespace(selectedText) + response.trim() + getTrailingWhitespace(selectedText)

    const diffs = diffLines(selectedText, normalizedResponse, {
        stripTrailingCr: true,
        ignoreNewlineAtEof: true,
    } as LinesOptions)

    const textDiff: TextDiff[] = []
    let startLine = selectedRange.start.line
    for (const part of diffs) {
        const count = part.count ?? 0
        if (part.removed) {
            if (part.value !== '\n') {
                textDiff.push({
                    type: 'deletion',
                    originalText: part.value,
                    range: new vscode.Range(startLine, 0, startLine + count, 0),
                })
            }
        } else if (part.added) {
            if (part.value !== '\n') {
                // The partial response sometimes doesn't have the correct ending newline character (\n), so we ensure that every insertion respects the code formatting.
                if (isPartialDiff && !part.value.endsWith('\n')) {
                    part.value += '\n'
                }
                textDiff.push({
                    type: 'insertion',
                    replacementText: part.value,
                    range: new vscode.Range(startLine, 0, startLine + count, 0),
                })
            }
        }
        startLine += count
    }
    inlineTask.diff = textDiff
    return textDiff
}

export function adjustTextDiffForEditing(textDiff: TextDiff[]): TextDiff[] {
    let linesAdded = 0
    const adjustedDiff: TextDiff[] = []

    for (const edit of textDiff) {
        const { range, type } = edit
        const { start, end } = range
        const linesChanged = end.line - start.line

        const adjustedRange = new vscode.Range(
            new vscode.Position(start.line - linesAdded, start.character),
            new vscode.Position(end.line - linesAdded, end.character)
        )

        adjustedDiff.push({
            ...edit,
            range: adjustedRange,
        })

        if (type === 'insertion') {
            linesAdded += linesChanged
        }
    }

    return adjustedDiff
}

export function getDiffBlocks(inlineTask: InlineTask): vscode.Range[] {
    const diff = inlineTask.diff

    if (!diff || diff.length === 0) {
        return []
    }

    const diffBlocks: vscode.Range[] = []
    let currentRange: vscode.Range | undefined

    for (const change of diff) {
        const { range } = change
        if (!currentRange || range.start.line !== currentRange.end.line) {
            currentRange = range
            diffBlocks.push(range)
        } else {
            currentRange = new vscode.Range(currentRange.start, range.end)
            diffBlocks[diffBlocks.length - 1] = currentRange
        }
    }

    return diffBlocks
}

function getLeadingWhitespace(str: string): string {
    const match = str.match(/^\s*/)
    return match ? match[0] : ''
}

function getTrailingWhitespace(str: string): string {
    const match = str.match(/\s*$/)
    return match ? match[0] : ''
}

/**
 * Widens the task selection to cover document lines that the response repeats verbatim
 * (ignoring indentation) immediately above and below the current selection.
 *
 * The model is given the code surrounding the selection as context and frequently answers with
 * the whole enclosing block, e.g. when inline chat is invoked on an empty line inside a function.
 * Diffing that response against the original (possibly empty) selection would insert the
 * surrounding lines a second time. By extending the selection to the echoed lines, they diff as
 * unchanged and only the genuinely new code is shown as an insertion.
 *
 * When lines are anchored, the response is re-indented so that its anchored lines line up with
 * the matching document lines.
 *
 * @returns the response, re-indented if anchoring occurred; otherwise the original response.
 */
export function anchorResponseToDocument(response: string, inlineTask: InlineTask): string {
    const document = inlineTask.document
    const responseLines = trimBlankLines(response.split('\n'))
    if (responseLines.length === 0) {
        return response
    }

    const startLine = inlineTask.selectedRange.start.line
    const endLine = inlineTask.selectedRange.end.line

    const prefixLength = findPrefixOverlap(document, startLine, responseLines)
    const suffixLength = findSuffixOverlap(document, endLine, responseLines, responseLines.length - prefixLength)
    if (prefixLength === 0 && suffixLength === 0) {
        return response
    }

    const anchoredStart = startLine - prefixLength
    const anchoredEnd = endLine + suffixLength
    inlineTask.selectedRange = new vscode.Range(
        document.lineAt(anchoredStart).range.start,
        document.lineAt(anchoredEnd).range.end
    )
    inlineTask.selectedText = document.getText(inlineTask.selectedRange)

    // Re-base the indentation of the response on the first anchored document line.
    const [documentLine, responseLine] =
        prefixLength > 0
            ? [document.lineAt(anchoredStart).text, responseLines[0]]
            : [document.lineAt(endLine + 1).text, responseLines[responseLines.length - suffixLength]]
    return reindent(responseLines, getLeadingWhitespace(responseLine), getLeadingWhitespace(documentLine)).join('\n')
}

/**
 * Number of response lines (from the start) that match the document lines directly above `line`.
 * Prefers the longest match.
 */
function findPrefixOverlap(document: vscode.TextDocument, line: number, responseLines: string[]): number {
    for (let length = Math.min(responseLines.length, line); length > 0; length--) {
        const documentLines = getDocumentLines(document, line - length, length)
        if (linesMatch(documentLines, responseLines.slice(0, length))) {
            return length
        }
    }
    return 0
}

/**
 * Number of response lines (from the end) that match the document lines directly below `line`.
 * Prefers the longest match.
 */
function findSuffixOverlap(
    document: vscode.TextDocument,
    line: number,
    responseLines: string[],
    maxLength: number
): number {
    const linesBelow = document.lineCount - 1 - line
    for (let length = Math.min(maxLength, linesBelow); length > 0; length--) {
        const documentLines = getDocumentLines(document, line + 1, length)
        if (linesMatch(documentLines, responseLines.slice(responseLines.length - length))) {
            return length
        }
    }
    return 0
}

function getDocumentLines(document: vscode.TextDocument, start: number, count: number): string[] {
    const lines: string[] = []
    for (let i = start; i < start + count; i++) {
        lines.push(document.lineAt(i).text)
    }
    return lines
}

function linesMatch(documentLines: string[], responseLines: string[]): boolean {
    return (
        documentLines.length === responseLines.length &&
        documentLines.every((line, i) => line.trim() === responseLines[i].trim())
    )
}

function trimBlankLines(lines: string[]): string[] {
    let start = 0
    let end = lines.length
    while (start < end && lines[start].trim() === '') {
        start++
    }
    while (end > start && lines[end - 1].trim() === '') {
        end--
    }
    return lines.slice(start, end)
}

function reindent(lines: string[], fromIndent: string, toIndent: string): string[] {
    if (fromIndent === toIndent) {
        return lines
    }
    return lines.map((line) => {
        if (line.trim() === '') {
            return line
        }
        return line.startsWith(fromIndent) ? toIndent + line.slice(fromIndent.length) : line
    })
}
