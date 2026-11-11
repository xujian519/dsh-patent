/**
 * 真实引擎端到端：无附图草案走 `build_patent_filing` → `verify_patent_filing` 的完整用户流程。
 *
 * 与 `tools.spec.ts` 的差别是这里不伪造子进程：`build.py` / `verify.py` 真实执行，
 * 产出真实 .docx 并由验收引擎重新打开核对。与 `filing-engine.e2e.ts` 一样落在不计覆盖率的
 * e2e 车道：它需要自带 `python-docx` 的解释器，单元车道不安装该依赖，整组按 host 能力跳过。
 * @module @deepseek-ai/dsh-patent-filing/tests/figureless-filing-real-engine
 */

import { execFileSync, spawn } from 'node:child_process'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SpecDraft } from '@deepseek-ai/dsh-patent-core'
import {
  createBuildPatentFilingTool,
  createVerifyPatentFilingTool,
  defaultSpecPath,
  defaultTemplatePath,
  findPython,
  renderBuildResult,
} from '@deepseek-ai/dsh-patent-filing'
import type { FilingBuildResult, FilingVerifyResult } from '@deepseek-ai/dsh-patent-filing'

/** 从成品 .docx 抽正文段，用来核对实际写进文档的章节。 */
const DOCX_TEXT_SCRIPT = [
  'import sys',
  'from docx import Document',
  'document = Document(sys.argv[1])',
  'print("\\n".join(paragraph.text for paragraph in document.paragraphs))',
].join('\n')

/**
 * 找一个能导入 `python-docx` 的解释器。
 * @returns 可用的解释器路径；本机没有自带依赖的解释器时返回 undefined（整组跳过）。
 */
function pythonWithDocx(): string | undefined {
  const candidate = findPython()
  if (candidate === undefined) return undefined
  try {
    execFileSync(candidate, ['-c', 'import docx'], { stdio: 'ignore', timeout: 10_000 })
    return candidate
  } catch {
    // 导入失败表示该解释器缺 python-docx（或根本不可用）；交给下一个候选。
  }
  return undefined
}

/** 将 node:child_process.spawn 适配为 SubprocessRuntime（收集 stdout/stderr 与退出码）。 */
function realSubprocess(): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdoutBuf = ''
      let stderrBuf = ''
      child.stdout.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })
      const stdinData = spec.stdio.stdin === 'ignore' ? '' : (spec.stdio.stdin as { data: string }).data
      child.stdin.end(stdinData)
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (code, signal) => { resolve({ exitCode: code, signal }) })
      })
      spec.signal?.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: stdoutBuf, nextOffset: stdoutBuf.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderrBuf, nextOffset: stderrBuf.length, lossy: false }) },
        },
        done,
        terminate: () => { child.kill('SIGTERM') },
        waitForExit: () => Promise.resolve(true),
      }
    },
  } as SubprocessRuntime
}

/**
 * 一件无附图发明的草案：`figureFiles` 与 `drawingDescriptions` 都是空数组，且不给
 * `abstractFigure`——这是工具说明与升级指南对模型的要求。
 * @returns 可通过 `validateSpecDraft` 的 claims-spec 草案。
 */
function figurelessDraft(): SpecDraft {
  return {
    meta: {
      caseNumber: 'CN2026-E2E-01',
      title: '一种智能保温杯',
      applicant: '示例申请人',
      inventor: '示例发明人',
      agent: '示例代理机构',
      date: '2026-11-11',
    },
    claims: ['一种智能保温杯，其特征在于，包括杯体、温控模块与电源。'],
    abstract: ['本发明公开一种智能保温杯，属于饮水器具领域，用于恒温饮水。'],
    figureFiles: [],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '本发明属于日用饮水器具技术领域。' }],
      background: [{ kind: 'paragraph', text: '现有保温杯难以长时间维持设定水温。' }],
      summary: [{ kind: 'paragraph', text: '本发明提供一种智能保温杯，可维持设定水温。' }],
      drawingDescriptions: [],
      embodiment: [{ kind: 'paragraph', text: '杯体与温控模块相连，温控模块由电源供电。' }],
    },
  }
}

const runtime = realSubprocess()
const pythonPath = pythonWithDocx()
const work = mkdtempSync(join(tmpdir(), 'dsh-patent-filing-e2e-'))

describe.skipIf(pythonPath === undefined)('real figureless filing end to end (needs python-docx)', () => {
  afterAll(() => { rmSync(work, { recursive: true, force: true }) })

  it('builds a 3-section .docx and passes verification', async () => {
    const python = pythonPath as string
    const build = createBuildPatentFilingTool({
      subprocess: runtime,
      pythonPath: python,
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      defaultOutputDir: join(work, '出件'),
      figureScale: 3,
      timeoutMs: 60_000,
    })
    const result = await build.execute(
      { draft: figurelessDraft(), outputName: '无附图_智能保温杯' },
      { signal: new AbortController().signal } as never,
    ) as FilingBuildResult

    expect(result.figures).toEqual([])
    expect(result.sections.map(section => section.key)).toEqual(['abstract', 'claims', 'specification'])
    expect(result.sections.every(section => section.figures === 0)).toBe(true)
    expect(existsSync(result.docxPath)).toBe(true)
    expect(renderBuildResult(result)).toContain('附图：0 张')

    const verify = createVerifyPatentFilingTool({
      subprocess: runtime,
      pythonPath: python,
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: 60_000,
    })
    const checked = await verify.execute(
      { docx: result.docxPath },
      { signal: new AbortController().signal } as never,
    ) as FilingVerifyResult

    expect(checked.errors).toEqual([])
    expect(checked.passed).toBe(true)
    expect(checked.info.sections).toBe(3)
    expect(checked.info.headers).toEqual(['说明书摘要', '权利要求书', '说明书'])
    expect(checked.info.figures).toBe(0)
    expect(checked.info.layout.map(section => section.key)).toEqual(['abstract', 'claims', 'specification'])

    // 成品本身也不得留下附图说明与摘要附图这类无附图发明不存在的章节。
    const text = execFileSync(python, ['-c', DOCX_TEXT_SCRIPT, result.docxPath], { encoding: 'utf8' })
    expect(text).toContain('技术领域')
    expect(text).toContain('具体实施方式')
    expect(text).not.toContain('附图说明')
    expect(text).not.toContain('摘要附图')
  }, 120_000)

  it('rejects abstractFigure when the application has no figures', async () => {
    const build = createBuildPatentFilingTool({
      subprocess: runtime,
      pythonPath: pythonPath as string,
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      defaultOutputDir: join(work, '出件'),
      figureScale: 3,
      timeoutMs: 60_000,
    })
    await expect(build.execute(
      { draft: { ...figurelessDraft(), abstractFigure: '1' }, outputName: '无附图_非法摘要附图' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow(/abstractFigure/)
  })
})
