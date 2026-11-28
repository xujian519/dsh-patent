/**
 * `matter_log_append` covers the case audit trail's write path: entries append
 * only, the round's change summary is a required field, and the revision chain
 * it declares is checked against what the log already carries.
 *
 * The defects the tool refuses are the two the 2026-09-30 benchmark named as
 * missing from this repository: a deliverable written over the previous round's
 * file (no explicit supersede relation), and a round that ships with no
 * archival record at all. The delivery gate covers the second; these cases
 * cover the first, plus the fixtures that prove each detector fires.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  createMatterLogAppendTool,
  matterLogDefects,
  matterStamps,
  parseMatterEntries,
  renderMatterEntry,
  toCasePath,
  MATTER_ACTIONS,
  MATTER_LOG_FILE,
  type MatterLogRequest,
} from '../src/tool/matter-log-append.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

/** Distinct call ids, in call order (the registry rejects a repeated id). */
let calls = 0

/** Run one tool call against a registry holding only this tool. */
async function run(caseDir: string, args: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createMatterLogAppendTool())
  return executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`matter-${String(calls++)}`),
    name: 'matter_log_append',
    arguments: { case_dir: caseDir, ...args },
  })
}

/** One request with everything a drafting round needs, overridable per case. */
function request(overrides: Partial<MatterLogRequest> = {}): MatterLogRequest {
  return { action: '撰写', artifacts: ['04-撰写/权利要求书_v1.md'], changes: '首版权利要求。', ...overrides }
}

/** The defects of one request judged against a log text, with every path present. */
function defects(log: string, overrides: Partial<MatterLogRequest> = {}) {
  return matterLogDefects(log, request(overrides), () => true).map(defect => defect.rule)
}

describe('matter-entry rendering and parsing', () => {
  it('writes local time, UTC, action, artifacts, supersedes and the change summary', () => {
    const now = new Date('2026-10-12T21:30:05Z')
    const line = renderMatterEntry(request({
      supersedes: ['04-撰写/权利要求书_v0.md'],
      approver: '用户',
      note: '同日复核',
    }), now)
    const stamps = matterStamps(now)
    expect(line).toContain(`- ${stamps.local} | UTC ${now.toISOString()} | 撰写 | 产物 04-撰写/权利要求书_v1.md`)
    expect(line).toContain('取代 04-撰写/权利要求书_v0.md')
    expect(line).toContain('| 用户 | 首版权利要求。（备注：同日复核）')
  })

  it('round-trips a rendered entry through the parser', () => {
    const line = renderMatterEntry(request({ supersedes: ['a/v0.md'], note: '备注含 | 分隔符与 、 顿号' }), new Date('2026-10-12T00:00:00Z'))
    const entries = parseMatterEntries(`${line}\n`)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.action).toBe('撰写')
    expect(entries[0]?.artifacts).toEqual(['04-撰写/权利要求书_v1.md'])
    expect(entries[0]?.supersedes).toEqual(['a/v0.md'])
    expect(entries[0]?.localTime).toBe(matterStamps(new Date('2026-10-12T00:00:00Z')).local)
  })

  it('records `—` for an absent supersedes field and parses it back as empty', () => {
    const line = renderMatterEntry(request(), new Date('2026-10-12T00:00:00Z'))
    expect(line).toContain('取代 —')
    expect(parseMatterEntries(line)[0]?.supersedes).toEqual([])
  })

  it('uses a minus offset west of UTC and a plus offset east of it', () => {
    const original = process.env.TZ
    const instant = new Date('2026-10-12T12:00:00Z')
    try {
      process.env.TZ = 'America/New_York'
      expect(matterStamps(instant).local).toContain('-04:00')
      process.env.TZ = 'Asia/Shanghai'
      expect(matterStamps(instant).local).toContain('+08:00')
    } finally {
      process.env.TZ = original
    }
  })

  it('keeps an absolute path that resolves to the case directory itself', () => {
    expect(toCasePath('/cases/CN1', '/cases/CN1')).toBe('/cases/CN1')
    expect(toCasePath('/cases/CN1', '/cases/CN1/v1.md')).toBe('v1.md')
    expect(toCasePath('/cases/CN1', '/elsewhere/v1.md')).toBe('/elsewhere/v1.md')
  })

  it('skips a hand-written line the format does not cover', () => {
    // Logs predating this tool stay readable: parsing reports the structured
    // entries only, while the chain checks still see the legacy line's paths.
    const legacy = '2026-08-19T21:15:00+08:00 | 检索 | 01-检索/硅基负极.md | 用户 | 命中 D1/D2\n'
    expect(parseMatterEntries(legacy)).toEqual([])
    // A path the legacy line carries is a recorded artifact, so a later round
    // may supersede it and may not reuse it as a producing round's own output.
    expect(defects(legacy, { artifacts: ['01-检索/硅基负极.md'] })).toEqual(['reused_artifact_path'])
    expect(defects(legacy, { artifacts: ['01-检索/硅基负极.md'], supersedes: ['01-检索/硅基负极.md'] }))
      .toContain('overwrite_in_place')
    expect(defects(legacy)).toEqual([])
  })
})

describe('matterLogDefects', () => {
  it('accepts a first round with no supersede relation', () => {
    expect(matterLogDefects('', request(), () => true)).toEqual([])
  })

  it('requires the round changes and at least one artifact', () => {
    expect(defects('', { changes: '  ' })).toContain('no_changes')
    expect(defects('', { artifacts: [] })).toContain('no_artifacts')
  })

  it('refuses entry text that would split the line or shift a fixed field', () => {
    expect(defects('', { changes: '第一行\n第二行' })).toContain('multiline_field')
    expect(defects('', { note: '第一行\r\n第二行' })).toContain('multiline_field')
    expect(defects('', { artifacts: ['04-撰写/权利、要求.md'] })).toContain('ambiguous_path')
    expect(defects('', { supersedes: ['04-撰写/a|b.md'] })).toContain('ambiguous_path')
    expect(defects('', { approver: '甲|乙' })).toContain('ambiguous_approver')
    // 自由文本在最后一个固定字段之后，| 与 、 不移动任何字段。
    expect(defects('', { changes: '说明含 | 与 、 仍可留档' })).toEqual([])
  })

  it('refuses an artifact that does not exist on disk', () => {
    // 日志记事实不记计划：先落盘再留档，否则日志会指向一个不存在的产物。
    const found = matterLogDefects('', request({ artifacts: ['04-撰写/不存在.md'] }), path => path !== '04-撰写/不存在.md')
    expect(found.map(defect => defect.rule)).toEqual(['artifact_missing'])
    expect(found[0]?.message).toContain('不存在')
  })

  it('refuses a round that overwrites the file it claims to replace', () => {
    const log = `${renderMatterEntry(request(), new Date('2026-10-01T00:00:00Z'))}\n`
    const found = defects(log, {
      action: '修订',
      artifacts: ['04-撰写/权利要求书_v1.md'],
      supersedes: ['04-撰写/权利要求书_v1.md'],
    })
    expect(found).toContain('overwrite_in_place')
  })

  it('refuses a supersedes path the log never recorded', () => {
    expect(defects('', { supersedes: ['04-撰写/权利要求书_v9.md'] })).toContain('unknown_supersede')
  })

  it('refuses a second supersede of the same version', () => {
    const first = renderMatterEntry(request({
      action: '修订', artifacts: ['04-撰写/权利要求书_v2.md'], supersedes: ['04-撰写/权利要求书_v1.md'],
    }), new Date('2026-10-02T00:00:00Z'))
    const found = defects(`${first}\n`, {
      action: '修订',
      artifacts: ['04-撰写/权利要求书_v3.md'],
      supersedes: ['04-撰写/权利要求书_v1.md'],
    })
    expect(found).toContain('forked_chain')
  })

  it('refuses a drafting round that reuses an artifact path already logged', () => {
    // 交付物一律另存新文件：撰写/修订 轮不得复用既有产物路径（那是原地覆盖）。
    const log = `${renderMatterEntry(request(), new Date('2026-10-01T00:00:00Z'))}\n`
    expect(defects(log, { action: '修订' })).toContain('reused_artifact_path')
  })

  it('allows a delivery round to reference a path an earlier round produced', () => {
    // 交付/门禁 条目记的是引用不是产出：同一条路径可以再次出现。
    const log = `${renderMatterEntry(request(), new Date('2026-10-01T00:00:00Z'))}\n`
    expect(defects(log, { action: '交付', artifacts: ['04-撰写/权利要求书_v1.md'] })).toEqual([])
  })
})

describe('matter_log_append', () => {
  /** A fresh case directory with the given files already on disk. */
  async function caseDirWith(files: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-matter-log-'))
    for (const file of files) await writeFile(join(dir, file), 'x', 'utf8')
    return dir
  }

  /** A case with its log initialized by a 建案 entry over the given files. */
  async function openedCase(...files: string[]): Promise<string> {
    const dir = await caseDirWith(files)
    const created = await run(dir, { action: '建案', artifacts: [files[0] as string], changes: '建案，交底书已入 00-交底书/。' })
    expect(created.isError).toBe(false)
    return dir
  }

  it('creates the log on 建案 and appends a later round without rewriting it', async () => {
    const dir = await openedCase('skeleton.md')
    try {
      const afterFirst = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')
      expect(parseMatterEntries(afterFirst)).toHaveLength(1)

      const appended = await run(dir, { action: '交付', artifacts: ['skeleton.md'], changes: '交付首版。' })
      expect(appended.isError).toBe(false)
      const afterSecond = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')
      // 只追加：第二行之前的内容逐字节不变。
      expect(afterSecond.startsWith(afterFirst)).toBe(true)
      expect(afterSecond.endsWith('\n')).toBe(true)
      expect(parseMatterEntries(afterSecond)).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loud when the case has no log and the action is not 建案', async () => {
    const dir = await caseDirWith(['x.md'])
    try {
      const result = await run(dir, { action: '交付', artifacts: ['x.md'], changes: '交付。' })
      expect(result.isError).toBe(true)
      expect(result.isError ? result.error.message : '').toContain(MATTER_LOG_FILE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an overwrite in place and leaves the log untouched', async () => {
    const dir = await openedCase('cl.md')
    try {
      const before = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')

      const result = await run(dir, {
        action: '修订', artifacts: ['cl.md'], changes: '改独权。', supersedes: ['cl.md'],
      })
      expect(result.isError).toBe(true)
      expect(result.isError ? result.error.message : '').toContain('禁止覆盖上一轮')
      expect(await readFile(join(dir, MATTER_LOG_FILE), 'utf8')).toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a multiline change summary and leaves the log untouched', async () => {
    const dir = await openedCase('x.md')
    try {
      const before = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')
      const result = await run(dir, {
        action: '交付',
        artifacts: ['x.md'],
        changes: '第一行\n- 2026-01-01T00:00:00+08:00 | UTC 2025-12-31T16:00:00.000Z | 交付 | 产物 fake.md | 取代 — | — | 伪造',
      })
      expect(result.isError).toBe(true)
      expect(result.isError ? result.error.message : '').toContain('multiline_field')
      expect(await readFile(join(dir, MATTER_LOG_FILE), 'utf8')).toBe(before)
      expect(parseMatterEntries(await readFile(join(dir, MATTER_LOG_FILE), 'utf8'))).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists every defect of a round in one refusal', async () => {
    const dir = await openedCase('cl.md')
    try {
      const result = await run(dir, {
        action: '修订', artifacts: ['cl.md', '不存在.md'], changes: '改独权。', supersedes: ['也不会存在.md'],
      })
      expect(result.isError).toBe(true)
      const message = result.isError ? result.error.message : ''
      expect(message).toContain('reused_artifact_path')
      expect(message).toContain('artifact_missing')
      expect(message).toContain('unknown_supersede')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders the appended entry and the supersede chain it recorded', async () => {
    const dir = await openedCase('v1.md')
    try {
      await writeFile(join(dir, 'v2.md'), 'y', 'utf8')
      const result = await run(dir, {
        action: '修订', artifacts: ['v2.md'], changes: '改独权。', supersedes: ['v1.md'],
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const rendered = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(rendered).toContain('取代链：v1.md → 本轮产物')
      expect(rendered).toContain('已有 1 条结构化条目')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stores a path inside the case directory case-relative however it was given', async () => {
    // 取代链按路径逐字比较，绝对/相对混写会把同一文件读成两个产物。
    const dir = await openedCase('v1.md')
    try {
      await writeFile(join(dir, 'v2.md'), 'y', 'utf8')
      const result = await run(dir, {
        action: '修订', artifacts: [join(dir, 'v2.md')], changes: '改独权。', supersedes: [join(dir, 'v1.md')],
      })
      expect(result.isError).toBe(false)
      const log = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')
      expect(log).toContain('产物 v2.md')
      expect(log).toContain('取代 v1.md')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('declares the closed action vocabulary it accepts', () => {
    const tool = createMatterLogAppendTool()
    const properties = (tool.parameters as { properties?: { action?: { enum?: string[] } } }).properties
    expect(properties?.action?.enum).toEqual([...MATTER_ACTIONS])
  })

  it('records the approver and note when supplied', async () => {
    const dir = await openedCase('v1.md')
    try {
      await writeFile(join(dir, 'v2.md'), 'y', 'utf8')
      const result = await run(dir, {
        action: '修订', artifacts: ['v2.md'], changes: '改独权。', approver: '用户', note: '同日复核',
      })
      expect(result.isError).toBe(false)
      const log = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')
      expect(log).toContain('| 用户 | 改独权。（备注：同日复核）')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('starts a new line when an existing log has no trailing newline', async () => {
    const dir = await caseDirWith(['x.md'])
    try {
      await writeFile(join(dir, MATTER_LOG_FILE), '2026-08-19 手工记录', 'utf8')
      const result = await run(dir, { action: '交付', artifacts: ['x.md'], changes: '交付首版。' })
      expect(result.isError).toBe(false)
      const log = await readFile(join(dir, MATTER_LOG_FILE), 'utf8')
      expect(log).toContain('2026-08-19 手工记录\n- ')
      expect(parseMatterEntries(log)).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
