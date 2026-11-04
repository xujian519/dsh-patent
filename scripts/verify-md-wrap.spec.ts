/**
 * The boundary table for `verify-md-wrap`: which sources the gate discovers and
 * which paragraphs it admits or rejects. The discovery cases matter as much as
 * the paragraph cases — a scan set that silently stops covering a tree reads
 * exactly like a clean tree, which is how `.agents/plans/**` went unchecked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findWrapViolations, markdownWrapSourcePaths } from './verify-md-wrap.ts'

/** Temporary repository roots to remove after each case. */
const roots: string[] = []

/**
 * Build a throwaway repository root holding the given files.
 * @param files - repository-relative paths mapped to their contents.
 * @returns the absolute root path.
 */
function layout(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), 'dsh-md-wrap-'))
  roots.push(base)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return base
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

describe('markdownWrapSourcePaths', () => {
  it('discovers plan documents, which no other tree carries', () => {
    // The 2026-11-04 gap: plans held the task lists a later implementation reads,
    // and neither wrap nor link discovery covered them.
    const root = layout({ '.agents/plans/2026-01-01-plan.md': '一段。\n' })
    expect(markdownWrapSourcePaths(root)).toEqual(['.agents/plans/2026-01-01-plan.md'])
  })

  it('discovers notes, package docs, and the agent instructions while excluding archived notes', () => {
    const root = layout({
      '.agents/notes/2026-01-01-note.md': '一段。\n',
      '.agents/notes/archived/process/frozen.md': '冻结。\n',
      'docs/guide.md': '一段。\n',
      'packages/core/README.md': '一段。\n',
      'packages/core/probe/docs/DETAIL.md': '一段。\n',
      'AGENTS.md': '一段。\n',
    })
    expect(markdownWrapSourcePaths(root).sort()).toEqual([
      '.agents/notes/2026-01-01-note.md',
      'AGENTS.md',
      'docs/guide.md',
      'packages/core/README.md',
      'packages/core/probe/docs/DETAIL.md',
    ])
  })

  it('does not reach outside its declared trees', () => {
    const root = layout({ 'scratch/other.md': '一段。\n' })
    expect(markdownWrapSourcePaths(root)).toEqual([])
  })
})

describe('findWrapViolations', () => {
  it('reports a paragraph continuing on a second physical line', () => {
    const root = layout({ 'docs/wrapped.md': '第一行\n第二行\n' })
    expect(findWrapViolations(join(root, 'docs/wrapped.md'), root))
      .toEqual([{ file: join('docs', 'wrapped.md'), line: 1, text: '第一行' }])
  })

  it('accepts one physical line per paragraph', () => {
    const root = layout({ 'docs/ok.md': '一段完整的文字。\n\n另一段。\n' })
    expect(findWrapViolations(join(root, 'docs/ok.md'), root)).toEqual([])
  })

  it('accepts a table row and a fenced block, and flags a list item continued on a second line', () => {
    // Tables and code keep their own line breaks. A list item's continuation is
    // itself a paragraph in the GFM AST, so it is held to one line like any
    // other prose — the gate's header says so, and a document that soft-wraps a
    // list item is the case it catches.
    const root = layout({
      'docs/structural.md': [
        '- 列表项第一行',
        '  列表项续行',
        '',
        '| 列一 | 列二 |',
        '|---|---|',
        '',
        '```ts',
        'const a = 1',
        'const b = 2',
        '```',
        '',
      ].join('\n'),
    })
    expect(findWrapViolations(join(root, 'docs/structural.md'), root))
      .toEqual([{ file: join('docs', 'structural.md'), line: 1, text: '- 列表项第一行' }])
  })

  it('accepts tables and fenced blocks on their own', () => {
    const root = layout({
      'docs/structure-only.md': [
        '| 列一 | 列二 |',
        '|---|---|',
        '',
        '```ts',
        'const a = 1',
        'const b = 2',
        '```',
        '',
      ].join('\n'),
    })
    expect(findWrapViolations(join(root, 'docs/structure-only.md'), root)).toEqual([])
  })

  it('ignores VitePress frontmatter and container delimiters', () => {
    const root = layout({ 'docs/site.md': '---\ntitle: 标题\ntags: 标签\n---\n\n::: tip\n:::  \n\n一段。\n' })
    expect(findWrapViolations(join(root, 'docs/site.md'), root)).toEqual([])
  })
})
