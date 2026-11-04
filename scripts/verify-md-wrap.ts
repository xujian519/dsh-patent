/**
 * Reject Markdown prose paragraphs spanning multiple physical lines. The GFM
 * AST distinguishes paragraphs—including those in lists and blockquotes—from
 * multiline structural nodes. The checker never rewrites; symlinked instruction
 * files are deduped. VitePress frontmatter and custom-container delimiters are
 * masked before parsing. The owning convention is in `docs/AGENTS.md`.
 */

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'
import { isArchivedAgentNotePath, uniqueRepoFiles } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Files to check: doc-typecheck's scope, system-prompt expected outputs, and the AGENTS.md pair. */
export const WRAP_PATTERNS = [
  'README.md',
  'README.zh.md',
  '.agents/notes/**/*.md',
  '.agents/plans/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/*/*.md',
  'packages/*/*/docs/*.md',
  'snapshots/**/system-prompt.expected.md',
  'packages/**/system-prompt.expected.md',
  'AGENTS.md',
  'packages/AGENTS.md',
  'snapshots/AGENTS.md',
]

/** A located hard-wrap: a prose paragraph spanning more than one source line. */
export interface WrapViolation {
  file: string
  /** 1-based line where the hard-wrapped paragraph starts. */
  line: number
  text: string
}

/**
 * Discover the Markdown sources this gate checks under `scanRoot`.
 * @param scanRoot - absolute repository root.
 * @returns forward-slash paths relative to `scanRoot`, archived notes excluded.
 */
export function markdownWrapSourcePaths(scanRoot: string = root): string[] {
  return uniqueRepoFiles(scanRoot, WRAP_PATTERNS, isArchivedAgentNotePath)
    .map(file => relative(scanRoot, file.abs).replaceAll('\\', '/'))
}

function maskVitePressStructure(source: string): string {
  const lines = source.split('\n')
  if (lines[0] === '---') {
    const closing = lines.indexOf('---', 1)
    if (closing !== -1) {
      for (let index = 0; index <= closing; index++) lines[index] = ''
    }
  }
  return lines.map(line => line.trimStart().startsWith(':::') ? '' : line).join('\n')
}

/**
 * Find every hard-wrapped prose paragraph in one Markdown file via its AST.
 * @param absPath - absolute path to the Markdown file.
 * @param scanRoot - absolute repository root used to report the relative path.
 * @returns one entry per hard-wrapped paragraph.
 */
export function findWrapViolations(absPath: string, scanRoot: string = root): WrapViolation[] {
  const file = relative(scanRoot, absPath)
  const source = readFileSync(absPath, 'utf8')
  const parsedSource = maskVitePressStructure(source)
  const tree = parseMarkdown(parsedSource)
  const out: WrapViolation[] = []

  visitMarkdown(tree, (node: Nodes): boolean | void => {
    if (node.type === 'paragraph' && node.position) {
      const { start, end } = node.position
      if (end.line > start.line) {
        const firstLine = source.split('\n')[start.line - 1] ?? ''
        out.push({ file, line: start.line, text: firstLine.trim() })
      }
      // Paragraph children are inline, so no further paragraph can be nested.
      return false
    }
  })
  return out
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const files = markdownWrapSourcePaths()
  const all = files.flatMap(file => findWrapViolations(resolve(root, file)))
  const checked = files.length

  if (all.length === 0) {
    console.log(`verify-md-wrap: ${checked} file(s) checked, no hard-wrapped prose paragraphs.`)
    process.exit(0)
  }

  console.error('verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):')
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  ${v.text.slice(0, 80)}${v.text.length > 80 ? '…' : ''}`)
  }
  process.exit(1)
}
