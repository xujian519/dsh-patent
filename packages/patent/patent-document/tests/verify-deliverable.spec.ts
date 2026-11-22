import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MAX_DELIVERABLE_FILE_BYTES,
  createVerifyDeliverableTool,
  deliverableSessionDirectory,
  renderDeliverableResult,
  verifyDeliverable,
} from '../src/tool/verify-deliverable.ts'
import type { VerifyDeliverableOutput } from '../src/tool/verify-deliverable.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-deliverable-'))
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Write a file with a fixed mtime (seconds since the epoch). */
function write(path: string, body: string, seconds: number): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  utimesSync(path, seconds, seconds)
  return path
}

describe('verifyDeliverable', () => {
  it('passes when each artifact matches its delivered copy and nothing precedes the render', () => {
    const dir = join(ROOT, 'clean')
    const canonical = write(join(dir, 'main/权利要求书.md'), '十项权利要求。', 1_000)
    const delivered = write(join(dir, 'batch/权利要求书.md'), '十项权利要求。', 1_000)
    const figure = write(join(dir, 'fig1.svg'), '<svg/>', 1_000)
    const rendered = write(join(dir, 'out.pdf'), '%PDF-1.4', 2_000)
    const out = verifyDeliverable({
      artifacts: [{ role: '权利要求书', canonical_path: canonical, delivered_path: delivered }],
      figures: [figure],
      rendered,
    })
    expect(out.passed).toBe(true)
    expect(out.violations).toEqual([])
    expect(out.manifest.map(m => m.role)).toEqual(['权利要求书', '附图', '渲染件'])
    expect(out.manifest[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.manifest[0]?.mtimeMs).toBe(1_000_000)
  })

  it('reports a main path still holding the superseded text', () => {
    const dir = join(ROOT, 'stale')
    const canonical = write(join(dir, 'main/权利要求书.md'), '十五项权利要求。', 1_000)
    const delivered = write(join(dir, 'batch/权利要求书.md'), '十项权利要求。', 2_000)
    const out = verifyDeliverable({ artifacts: [{ role: '权利要求书', canonical_path: canonical, delivered_path: delivered }] })
    const v = out.violations.find(x => x.rule === 'artifact_mismatch')
    expect(out.passed).toBe(false)
    expect(v?.severity).toBe('error')
    expect(v?.message).toContain('案卷主路径与交付版内容不一致')
    expect(out.manifest).toHaveLength(1)
  })

  it('reports an artifact path that cannot be read, once, naming the role', () => {
    const dir = join(ROOT, 'missing')
    const present = write(join(dir, 'a.md'), '正文。', 1_000)
    const out = verifyDeliverable({
      artifacts: [
        { role: '权利要求书', canonical_path: join(dir, 'absent.md'), delivered_path: present },
        { role: '说明书', canonical_path: present, delivered_path: join(dir, 'absent.md') },
      ],
    })
    expect(out.violations.map(v => v.rule)).toEqual(['artifact_missing', 'artifact_missing'])
    expect(out.violations[0]?.message).toContain('权利要求书')
    expect(out.violations[1]?.message).toContain('说明书')
    expect(out.manifest).toEqual([])
  })

  it('rejects a directory in place of a deliverable path', () => {
    const dir = join(ROOT, 'directory')
    const present = write(join(dir, 'a.md'), '正文。', 1_000)
    const directory = join(dir, 'a-directory')
    mkdirSync(directory, { recursive: true })
    const out = verifyDeliverable({
      artifacts: [{ role: '权利要求书', canonical_path: directory, delivered_path: present }],
    })
    expect(out.violations.map(v => v.rule)).toEqual(['artifact_missing'])
    expect(out.violations[0]?.message).toContain('不是普通文件')
    expect(out.manifest).toEqual([])
  })

  it('rejects a file above the hash limit without reading it', () => {
    const dir = join(ROOT, 'oversized')
    const present = write(join(dir, 'a.md'), '正文。', 1_000)
    const huge = join(dir, 'huge.pdf')
    writeFileSync(huge, '')
    truncateSync(huge, MAX_DELIVERABLE_FILE_BYTES + 1)
    const out = verifyDeliverable({
      artifacts: [{ role: '渲染件', canonical_path: present, delivered_path: huge }],
      rendered: huge,
    })
    expect(out.violations.map(v => v.rule)).toEqual(['artifact_missing', 'rendered_missing'])
    expect(out.violations[0]?.message).toContain('超过')
    expect(out.manifest).toEqual([])
  })

  it('reports an empty artifact list instead of passing vacuously', () => {
    const out = verifyDeliverable({ artifacts: [] })
    expect(out.passed).toBe(false)
    expect(out.violations.map(v => v.rule)).toEqual(['no_artifacts'])
  })

  it('reports a missing drawing', () => {
    const dir = join(ROOT, 'nofig')
    const missingFigure = join(dir, 'fig9.svg')
    const out = verifyDeliverable({ artifacts: [], figures: [missingFigure] })
    expect(out.violations.map(v => v.rule)).toEqual(['no_artifacts', 'figure_missing'])
    expect(out.violations[1]?.message).toContain(missingFigure)
  })

  it('reports a rendered file that cannot be read', () => {
    const dir = join(ROOT, 'norender')
    const out = verifyDeliverable({ artifacts: [], rendered: join(dir, 'out.pdf') })
    expect(out.violations.map(v => v.rule)).toEqual(['no_artifacts', 'rendered_missing'])
  })

  it('reports a render produced before its newest input, naming that input', () => {
    const dir = join(ROOT, 'order')
    const canonical = write(join(dir, 'main/说明书.md'), '说明书。', 1_000)
    const delivered = write(join(dir, 'batch/说明书.md'), '说明书。', 1_000)
    const figure = write(join(dir, 'fig1.svg'), '<svg/>', 5_000)
    const rendered = write(join(dir, 'out.pdf'), '%PDF-1.4', 2_000)
    const out = verifyDeliverable({
      artifacts: [{ role: '说明书', canonical_path: canonical, delivered_path: delivered }],
      figures: [figure],
      rendered,
    })
    const v = out.violations.find(x => x.rule === 'render_order')
    expect(out.passed).toBe(false)
    expect(v?.message).toContain('渲染件早于其输入件')
    expect(v?.message).toContain('附图')
  })

  it('renders the manifest and the violations', () => {
    const dir = join(ROOT, 'render-text')
    const canonical = write(join(dir, 'main/权利要求书.md'), '旧版。', 1_000)
    const delivered = write(join(dir, 'batch/权利要求书.md'), '新版。', 1_000)
    const out = verifyDeliverable({ artifacts: [{ role: '权利要求书', canonical_path: canonical, delivered_path: delivered }] })
    const text = renderDeliverableResult(out)
    expect(text).toContain('交付件核对：未通过')
    expect(text).toContain('## 交付清单')
    expect(text).toContain('## 违规项')
    expect(text).toContain('→ 把交付版复制到主路径并归档旧版')

    const clean = verifyDeliverable({ artifacts: [{ role: '权利要求书', canonical_path: canonical, delivered_path: canonical }] })
    const cleanText = renderDeliverableResult(clean)
    expect(cleanText).toContain('交付件核对：通过')
    expect(cleanText).not.toContain('## 违规项')
  })

  it('reads a relative path against the given session directory, including a path outside that directory when it is absolute', () => {
    const sessionDir = join(ROOT, 'session-rel')
    const outside = join(ROOT, 'outside-abs')
    const relative = join('00_项目总览', '台账.md')
    const canonical = write(join(sessionDir, relative), '台账。', 1_000)
    const figure = write(join(sessionDir, 'fig1.svg'), '<svg/>', 1_000)
    const rendered = write(join(sessionDir, 'out.pdf'), '%PDF-1.4', 2_000)
    const evidence = write(join(sessionDir, 'check.log'), '通过', 1_000)
    const absolute = write(join(outside, 'claims.md'), '绝对路径。', 1_000)
    const out = verifyDeliverable({
      artifacts: [
        { role: '台账', canonical_path: relative, delivered_path: relative },
        { role: '权利要求书', canonical_path: absolute, delivered_path: absolute },
      ],
      figures: ['fig1.svg'],
      rendered: 'out.pdf',
      requirements: [{ requirement: '台账已核对', evidence: ['check.log'] }],
    }, sessionDir)
    expect(out.passed).toBe(true)
    expect(out.violations).toEqual([])
    expect(out.manifest.map(record => record.path)).toEqual([canonical, absolute, figure, rendered, evidence])
    expect(out.requirements?.[0]).toEqual({
      requirement: '台账已核对',
      evidence: ['check.log'],
      satisfied: true,
    })
  })

  it('names the session directory when a relative path cannot be read', () => {
    const sessionDir = join(ROOT, 'session-miss')
    mkdirSync(sessionDir, { recursive: true })
    const out = verifyDeliverable({
      artifacts: [{ role: '权利要求书', canonical_path: 'missing.md', delivered_path: 'missing.md' }],
      requirements: [{ requirement: '有证据', evidence: ['nope.log'] }],
    }, sessionDir)
    expect(out.passed).toBe(false)
    expect(out.manifest).toEqual([])
    expect(out.violations.map(violation => violation.rule)).toEqual(['artifact_missing', 'requirement_evidence_missing'])
    for (const violation of out.violations) {
      expect(violation.message).toContain('会话目录')
      expect(violation.message).toContain(sessionDir)
    }
    expect(out.violations[0]?.message).toContain('missing.md')
    expect(out.violations[0]?.message).toContain(resolve(sessionDir, 'missing.md'))
    expect(out.requirements?.[0]?.satisfied).toBe(false)
  })

  it('renders a violation without a suggestion', () => {
    const text = renderDeliverableResult({
      passed: false,
      manifest: [],
      violations: [{ rule: 'bare', severity: 'error', message: '裸违规' }],
    })
    expect(text).toContain('裸违规')
    expect(text).not.toContain('→')
    expect(text).not.toContain('## 交付清单')
  })
})

describe('createVerifyDeliverableTool', () => {
  it('declares the defineTool shape over the artifact parameters', () => {
    const tool = createVerifyDeliverableTool()
    expect(tool.name).toBe('verify_deliverable')
    expect(tool.description.length).toBeGreaterThan(0)
    const parameters = tool.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('artifacts')
    expect(parameters.properties).toHaveProperty('figures')
    expect(parameters.properties).toHaveProperty('rendered')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.execute).toBe('function')
  })

  it('checks the artifacts it receives and reports the result', async () => {
    const dir = join(ROOT, 'tool')
    const canonical = write(join(dir, 'main/摘要.md'), '摘要。', 1_000)
    const delivered = write(join(dir, 'batch/摘要.md'), '摘要。', 1_000)
    const tool = createVerifyDeliverableTool()
    const value = (await tool.execute(
      { artifacts: [{ role: '摘要', canonical_path: canonical, delivered_path: delivered }] },
      { signal: new AbortController().signal } as never,
    )) as VerifyDeliverableOutput
    expect(value.passed).toBe(true)
    const blocks = tool.output.render({}, value as never)
    // vitest asymmetric matcher is typed any; the literal text field holds the matcher object
    const textMatcher = expect.stringContaining('交付件核对：通过') as string
    expect(blocks).toEqual([{ type: 'text', text: textMatcher }])
  })
})

describe('deliverableSessionDirectory', () => {
  /** Session directory that does not touch the filesystem service. */
  class FixedDirectory extends WorkingDirectory {
    override async ensure(): Promise<string> {
      return this.defaultDirectory
    }
  }

  it('uses the process directory when the call has no agent', async () => {
    await expect(deliverableSessionDirectory(new Context(), { signal: new AbortController().signal } as never)).resolves.toBe(process.cwd())
  })

  it('rejects a session call when the working-directory service is absent', async () => {
    await expect(deliverableSessionDirectory(new Context(), {
      signal: new AbortController().signal,
      agent: {},
    } as never)).rejects.toMatchObject({
      name: 'ToolContextUnavailableError',
      code: 'TOOL_CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('working-directory') as string,
    })
    await expect(deliverableSessionDirectory(new Context(), {
      signal: new AbortController().signal,
      agent: {},
    } as never)).rejects.toBeInstanceOf(ToolContextUnavailableError)
  })

  it('records TOOL_CONTEXT_UNAVAILABLE on tool/result when an agent call has no working-directory service', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.tools.register(createVerifyDeliverableTool(ctx))
      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('verify-missing-directory'),
        name: 'verify_deliverable',
        arguments: {
          artifacts: [{ role: '权利要求书', canonical_path: '/tmp/claims.md', delivered_path: '/tmp/claims.md' }],
        },
        agent: {} as never,
      })
      expect(result).toMatchObject({
        isError: true,
        error: { info: { name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' } },
      })
      expect(result.error?.message).toContain('working-directory')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves a relative deliverable against the session directory, not the process directory', async () => {
    const sessionDir = join(ROOT, 'tool-session')
    write(join(sessionDir, 'claims.md'), '权利要求书', 1_000)
    const ctx = new Context()
    try {
      new FixedDirectory(ctx, { defaultDirectory: sessionDir })
      const tool = createVerifyDeliverableTool(ctx)
      const value = (await tool.execute(
        { artifacts: [{ role: '权利要求书', canonical_path: 'claims.md', delivered_path: 'claims.md' }] },
        { signal: new AbortController().signal, agent: {} } as never,
      )) as VerifyDeliverableOutput
      expect(value.passed).toBe(true)
      expect(value.manifest[0]?.path).toBe(resolve(sessionDir, 'claims.md'))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('verify_deliverable 用户要求逐条核对表', () => {
  it('每条要求给出证据文件即满足，核对表随结果返回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deliv-req-'))
    try {
      writeFileSync(join(dir, 'claims.md'), '权利要求书')
      writeFileSync(join(dir, 'check.log'), 'heading_set: 通过')
      const value = verifyDeliverable({
        artifacts: [{ role: '权利要求书', canonical_path: join(dir, 'claims.md'), delivered_path: join(dir, 'claims.md') }],
        requirements: [
          { requirement: '权利要求不超过 10 项', evidence: [join(dir, 'check.log')] },
        ],
      })
      expect(value.passed).toBe(true)
      expect(value.requirements).toEqual([
        { requirement: '权利要求不超过 10 项', evidence: [join(dir, 'check.log')], satisfied: true },
      ])
      const rendered = renderDeliverableResult(value)
      expect(rendered).toContain('## 用户要求逐条核对')
      expect(rendered).toContain('- [满足] 权利要求不超过 10 项 → 证据：')
      expect(rendered).toContain('[证据]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有证据的要求报错并按未满足处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deliv-req-'))
    try {
      writeFileSync(join(dir, 'claims.md'), '权利要求书')
      const value = verifyDeliverable({
        artifacts: [{ role: '权利要求书', canonical_path: join(dir, 'claims.md'), delivered_path: join(dir, 'claims.md') }],
        requirements: [{ requirement: '说明书不得自加标题', evidence: [] }],
      })
      expect(value.passed).toBe(false)
      expect(value.violations.map(v => v.rule)).toContain('requirement_without_evidence')
      expect(value.requirements?.[0]?.satisfied).toBe(false)
      expect(renderDeliverableResult(value)).toContain('（无证据）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('证据文件不存在时报错；同一证据文件在多条要求下只记一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deliv-req-'))
    try {
      writeFileSync(join(dir, 'claims.md'), '权利要求书')
      writeFileSync(join(dir, 'check.log'), 'ok')
      const value = verifyDeliverable({
        artifacts: [{ role: '权利要求书', canonical_path: join(dir, 'claims.md'), delivered_path: join(dir, 'claims.md') }],
        requirements: [
          { requirement: 'A', evidence: [join(dir, 'nope.log')] },
          { requirement: 'B', evidence: [join(dir, 'check.log')] },
          { requirement: 'C', evidence: [join(dir, 'check.log')] },
        ],
      })
      expect(value.violations.map(v => v.rule)).toContain('requirement_evidence_missing')
      expect(value.requirements?.map(row => row.satisfied)).toEqual([false, true, true])
      expect(value.manifest.filter(record => record.role === '证据')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未给 requirements 时结果与渲染都不出现核对表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deliv-req-'))
    try {
      writeFileSync(join(dir, 'claims.md'), '权利要求书')
      const value = verifyDeliverable({
        artifacts: [{ role: '权利要求书', canonical_path: join(dir, 'claims.md'), delivered_path: join(dir, 'claims.md') }],
      })
      expect(value.requirements).toBeUndefined()
      expect(renderDeliverableResult(value)).not.toContain('用户要求逐条核对')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requirements 给空数组时返回空核对表（渲染不出该小节）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deliv-req-'))
    try {
      writeFileSync(join(dir, 'claims.md'), '权利要求书')
      const value = verifyDeliverable({
        artifacts: [{ role: '权利要求书', canonical_path: join(dir, 'claims.md'), delivered_path: join(dir, 'claims.md') }],
        requirements: [],
      })
      expect(value.requirements).toEqual([])
      expect(renderDeliverableResult(value)).not.toContain('用户要求逐条核对')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
