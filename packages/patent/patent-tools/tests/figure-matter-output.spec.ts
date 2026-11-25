import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../src/figure/graphviz-renderer.ts'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import { PatentToolError } from '../src/error.ts'

const exec = { signal: new AbortController().signal } as never

const flowSteps = [
  { id: 'start', label: '开始', shape: 'ellipse' as const, next: ['end'] },
  { id: 'end', label: '结束', shape: 'ellipse' as const, next: [] },
]

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function okRenderer(): (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> {
  return (spec) => {
    const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
    writeFileSync(out, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    return Promise.resolve({ ok: true, path: out })
  }
}

describe('generate_patent_figure matter output', () => {
  it('writes the figure inside the resolved matter directory when no output directory is configured', async () => {
    const cwd = tempDir('dsh-fig-cwd-')
    const workRoot = tempDir('dsh-fig-work-')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(), cwd, workRoot })
    try {
      const value = await tool.execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        case_id: 'CN-1',
        filename: 'fig1',
        persist_index: false,
      }, exec) as { absolutePath: string }
      expect(value.absolutePath).toBe(join(workRoot, 'CN-1', '04-撰写', 'fig1.svg'))
      expect(existsSync(value.absolutePath)).toBe(true)
      expect(existsSync(join(cwd, 'patent', 'figures'))).toBe(false)
      expect(existsSync(join(cwd, '.dsh', 'documents'))).toBe(false)
      expect(existsSync(join(cwd, 'data', 'cases'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(workRoot, { recursive: true, force: true })
    }
  })

  it('still writes to an explicitly configured directory', async () => {
    const cwd = tempDir('dsh-fig-cwd-')
    const explicit = join(cwd, 'patent', 'figures')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(), cwd, outputDir: explicit })
    try {
      const value = await tool.execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        case_id: 'CN-1',
        filename: 'fig1',
        persist_index: false,
      }, exec) as { absolutePath: string }
      expect(value.absolutePath).toBe(join(explicit, 'fig1.svg'))
      expect(existsSync(value.absolutePath)).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('writes into the working directory when that directory is already the matter', async () => {
    const cwd = tempDir('dsh-fig-matter-')
    writeFileSync(join(cwd, '_matter-log.md'), '# log\n')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(), cwd })
    try {
      const value = await tool.execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        filename: 'fig1',
        persist_index: false,
      }, exec) as { absolutePath: string }
      expect(value.absolutePath).toBe(join(cwd, '04-撰写', 'fig1.svg'))
      expect(existsSync(value.absolutePath)).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('fails when the matter directory cannot be resolved and no output directory is configured', async () => {
    const cwd = tempDir('dsh-fig-cwd-')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(), cwd })
    try {
      await expect(tool.execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        filename: 'fig1',
        persist_index: false,
      }, exec)).rejects.toBeInstanceOf(PatentToolError)
      expect(existsSync(join(cwd, 'patent', 'figures'))).toBe(false)
      expect(existsSync(join(cwd, '.dsh', 'documents'))).toBe(false)
      expect(existsSync(join(cwd, 'data', 'cases'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
