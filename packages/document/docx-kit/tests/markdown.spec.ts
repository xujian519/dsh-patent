// 上游来源：Mady 项目 `domains/doctmpl/renderer_docx_test.go` 的
// `TestDOCXRenderer_Render` 内联 Markdown 样例（标题、加粗段落、无序列表、表格），
// 以及 `domains/doctmpl/renderer_docx.go` 的 `parseHeading`/`isListItem`/
// `isTableSeparator`/`parseTableRow`/`docxInlineRunsXML` 决策。

import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '../src/markdown.ts'
import type { DocxBlock, DocxInlineRun } from '../src/types.ts'

/** 上游 `TestDOCXRenderer_Render` 的 Markdown 正文。 */
const UPSTREAM_MARKDOWN = '# 技术标题\n\n这是一段**加粗**文字。\n\n- 列表项一\n- 列表项二\n\n'
  + '| 名称 | 数值 |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n'

const INLINE_CASES: [name: string, text: string, expected: string[]][] = [
  ['plain text', 'plain text', ['p:plain text']],
  ['a bold span', 'a **b** c', ['p:a ', 'b:b', 'p: c']],
  ['a code span', 'a `b` c', ['p:a ', 'pc:b', 'p: c']],
  ['both markers', '**a** and `b`', ['b:a', 'p: and ', 'pc:b']],
  ['an empty bold span', '****', ['b:']],
  ['a code span around markers', '`a**b**`', ['pc:a**b**']],
  ['an unpaired bold marker', 'unpaired **marker', ['p:unpaired ', 'p:*', 'p:*marker']],
  ['an unpaired code marker', '`unpaired', ['p:`', 'p:unpaired']],
  ['an empty line', '', []],
]

const HEADING_CASES: [source: string, level: number][] = [
  ['# one', 1],
  ['## two', 2],
  ['### three', 3],
  ['#### four', 4],
  ['##### five', 5],
  ['###### six', 6],
]

const PARAGRAPH_CASES: [name: string, source: string][] = [
  ['seven hashes', '####### seven'],
  ['no space after the marker', '#noseparator'],
  ['a bare marker', '#'],
  ['a tab separator', '#\ttab'],
  ['a paragraph', 'plain'],
]

/** Compact view of a span list, so one assertion covers text and both decorations. */
function markup(runs: readonly DocxInlineRun[]): string[] {
  return runs.map(run => `${run.bold ? 'b' : 'p'}${run.code ? 'c' : ''}:${run.text}`)
}

/** Block kinds in source order. */
function kinds(blocks: readonly DocxBlock[]): string[] {
  return blocks.map(block => block.kind)
}

/** Span list of a paragraph block, or `undefined` when the block is of another kind. */
function paragraphRuns(block: DocxBlock | undefined): string[] | undefined {
  return block?.kind === 'paragraph' ? markup(block.runs) : undefined
}

/** Span list of a list item block, or `undefined` when the block is of another kind. */
function listItemRuns(block: DocxBlock | undefined): string[] | undefined {
  return block?.kind === 'listItem' ? markup(block.runs) : undefined
}

/** Row widths of a table block, or `undefined` when the block is of another kind. */
function rowWidths(blocks: readonly DocxBlock[]): number[] | undefined {
  const block = blocks[0]
  return block?.kind === 'table' ? block.rows.map(row => row.length) : undefined
}

/** Cell texts of the first table in `blocks`. */
function tableCells(blocks: readonly DocxBlock[]): string[][] | undefined {
  const block = blocks.find(item => item.kind === 'table')
  return block?.kind === 'table'
    ? block.rows.map(row => row.map(cell => cell.map(run => run.text).join('')))
    : undefined
}

describe('parseInline', () => {
  it.each(INLINE_CASES)('reads %s', (_name, text, expected) => {
    expect(markup(parseInline(text))).toEqual(expected)
  })
})

describe('parseMarkdown', () => {
  it('reads the upstream sample into the four block kinds', () => {
    const blocks = parseMarkdown(UPSTREAM_MARKDOWN)
    expect(kinds(blocks)).toEqual(['heading', 'paragraph', 'listItem', 'listItem', 'table'])
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: '技术标题' })
    expect(paragraphRuns(blocks[1])).toEqual(['p:这是一段', 'b:加粗', 'p:文字。'])
    expect(listItemRuns(blocks[2])).toEqual(['p:列表项一'])
    expect(blocks[4]).toEqual({
      kind: 'table',
      rows: [
        [[{ text: '名称', bold: false, code: false }], [{ text: '数值', bold: false, code: false }]],
        [[{ text: 'A', bold: false, code: false }], [{ text: '1', bold: false, code: false }]],
        [[{ text: 'B', bold: false, code: false }], [{ text: '2', bold: false, code: false }]],
      ],
    })
  })

  it.each(HEADING_CASES)('reads %s as a heading', (source, level) => {
    expect(parseMarkdown(source)).toEqual([{ kind: 'heading', level, text: source.slice(level + 1) }])
  })

  it.each(PARAGRAPH_CASES)('reads %s as paragraph text', (_name, source) => {
    expect(parseMarkdown(source)).toEqual([{ kind: 'paragraph', runs: [{ text: source, bold: false, code: false }] }])
  })

  it('joins consecutive plain lines into one paragraph', () => {
    expect(parseMarkdown('a\nb\n\nc')).toEqual([
      { kind: 'paragraph', runs: [{ text: 'a b', bold: false, code: false }] },
      { kind: 'paragraph', runs: [{ text: 'c', bold: false, code: false }] },
    ])
  })

  it('trims line endings and list markers', () => {
    expect(parseMarkdown('* item\r\n')).toEqual([{ kind: 'listItem', runs: [{ text: 'item', bold: false, code: false }] }])
  })

  it('drops a table separator row and keeps a colon row as data', () => {
    expect(parseMarkdown('| a | b |\n| :--- | ---: |')).toEqual([{
      kind: 'table',
      rows: [
        [[{ text: 'a', bold: false, code: false }], [{ text: 'b', bold: false, code: false }]],
        [[{ text: ':---', bold: false, code: false }], [{ text: '---:', bold: false, code: false }]],
      ],
    }])
  })

  it('keeps a dash line that is the header and drops only the following separator', () => {
    expect(tableCells(parseMarkdown('| --- |\n| --- |'))).toEqual([['---']])
  })

  it('keeps an escaped pipe and a dash row that follows the separator', () => {
    expect(tableCells(parseMarkdown('| 特征 | 说明 |\n| --- | --- |\n| A\\|B | 含有竖线 |\n| - | - |\n| C | 末行 |\n'))).toEqual([
      ['特征', '说明'],
      ['A|B', '含有竖线'],
      ['-', '-'],
      ['C', '末行'],
    ])
  })

  it('keeps a dash line that opens a later table', () => {
    const blocks = parseMarkdown('| a |\n| --- |\n\n| --- |')
    expect(kinds(blocks)).toEqual(['table', 'table'])
    expect(tableCells(blocks.slice(0, 1))).toEqual([['a']])
    expect(tableCells(blocks.slice(1))).toEqual([['---']])
  })

  it('reads a row that does not close with a pipe', () => {
    expect(tableCells(parseMarkdown('| a | b'))).toEqual([['a', 'b']])
  })

  it('reads a lone pipe as one empty cell', () => {
    expect(rowWidths(parseMarkdown('|'))).toEqual([1])
  })

  it('closes a table when a plain line follows it', () => {
    expect(kinds(parseMarkdown('| a |\n\nafter'))).toEqual(['table', 'paragraph'])
  })

  it('reads a ragged row as its own cells', () => {
    expect(rowWidths(parseMarkdown('| a | b |\n| c |'))).toEqual([2, 1])
  })

  it('reads an empty cell', () => {
    expect(rowWidths(parseMarkdown('||'))).toEqual([1])
  })
})

describe('parseMarkdown fenced code', () => {
  it('keeps headings, tables, and bold markers inside a fence as code text', () => {
    const blocks = parseMarkdown('```\n# not a heading\n| a | b |\n**not bold**\n```')

    expect(kinds(blocks)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(blocks.map(paragraphRuns)).toEqual([['pc:# not a heading'], ['pc:| a | b |'], ['pc:**not bold**']])
  })

  it('drops the info string and resumes block parsing after the closing fence', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1\n```\n# heading after')

    expect(blocks).toEqual([
      { kind: 'paragraph', runs: [{ text: 'const x = 1', bold: false, code: true }] },
      { kind: 'heading', level: 1, text: 'heading after' },
    ])
  })

  it('accepts a tilde fence', () => {
    expect(parseMarkdown('~~~\n# code\n~~~')).toEqual([
      { kind: 'paragraph', runs: [{ text: '# code', bold: false, code: true }] },
    ])
  })

  it('keeps the fence open until a run at least as long as the opening one', () => {
    const blocks = parseMarkdown('````\n# still code\n```\nalso code\n````')

    expect(blocks.map(paragraphRuns)).toEqual([['pc:# still code'], ['pc:```'], ['pc:also code']])
  })

  it('keeps indentation and trailing spaces of code lines', () => {
    const blocks = parseMarkdown('```\n    indented  \n```')

    expect(blocks).toEqual([
      { kind: 'paragraph', runs: [{ text: '    indented  ', bold: false, code: true }] },
    ])
  })

  it('treats an unclosed fence as code to the end of the source', () => {
    expect(kinds(parseMarkdown('```\na\n# b'))).toEqual(['paragraph', 'paragraph'])
  })

  it('closes a fence opened with leading indentation', () => {
    expect(kinds(parseMarkdown('  ```\nx\n  ```\nafter'))).toEqual(['paragraph', 'paragraph'])
  })

  it('closes the open table before a fence', () => {
    expect(kinds(parseMarkdown('| a |\n```\nx\n```'))).toEqual(['table', 'paragraph'])
  })

  it('keeps an empty code line as an empty paragraph', () => {
    expect(parseMarkdown('```\n\n```')).toEqual([
      { kind: 'paragraph', runs: [{ text: '', bold: false, code: true }] },
    ])
  })

  it('does not open a fence indented past three spaces', () => {
    expect(kinds(parseMarkdown('    ```\n# heading'))).toEqual(['paragraph', 'heading'])
  })

  it('does not treat a backtick run whose info carries a backtick as a fence', () => {
    expect(kinds(parseMarkdown('``` a`b\n# heading'))).toEqual(['paragraph', 'heading'])
  })

  it('ignores a closing line with trailing text or deeper indentation', () => {
    const blocks = parseMarkdown('```\n``` still code\n    ```\n```')

    expect(blocks.map(paragraphRuns)).toEqual([['pc:``` still code'], ['pc:    ```']])
  })

  it('does not open a fence with fewer than three markers', () => {
    expect(kinds(parseMarkdown('``\n# heading'))).toEqual(['paragraph', 'heading'])
  })

  it('allows a backtick in a tilde fence info string', () => {
    expect(kinds(parseMarkdown('~~~ a`b\n# code\n~~~'))).toEqual(['paragraph'])
  })
})
