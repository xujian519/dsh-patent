import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_FREECAD_PROBE_TIMEOUT_MS,
  DEFAULT_FREECAD_RENDER_TIMEOUT_MS,
  FREECAD_CMD_CANDIDATES,
  findFreeCadCmd,
  freecadInstallMessage,
  probeFreeCad,
  renderSectionGeometry,
  renderSectionHatch,
  renderStructureViews,
  type SectionHatchSpec,
  type StructureRenderSpec,
} from '../src/figure/freecad-renderer.ts'
import { HATCH_GEOMETRY_FILENAME } from '../src/figure/freecad-hatch-script.ts'
import { SECTION_GEOMETRY_FILENAME } from '../src/figure/freecad-section-script.ts'

/** 用例显式声明的渲染预算（毫秒）；生产由宿主 Config.freecadRenderTimeoutMs 解析后注入。 */
const TEST_RENDER_TIMEOUT_MS = DEFAULT_FREECAD_RENDER_TIMEOUT_MS

/** 用例显式声明的探测预算（毫秒）；宿主插件不探测 freecadcmd，无对应 Config 字段。 */
const TEST_PROBE_TIMEOUT_MS = DEFAULT_FREECAD_PROBE_TIMEOUT_MS

/** 渲染超时用例注入的非默认预算（毫秒）：证明期限取自注入值而非渲染器模块默认值。 */
const INJECTED_RENDER_TIMEOUT_MS = 1_500
import {
  STRUCTURE_MANIFEST_FILENAME,
  STRUCTURE_TEMPLATE_FILENAME,
  STRUCTURE_TRANSIENT_DIRNAME,
} from '../src/figure/freecad-structure-script.ts'

// 清理可被置为失败：验证「清理失败不顶掉渲染结果」的收尾分支。
const mockFsOps = vi.hoisted(() => ({ failRm: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: ((...args: Parameters<typeof actual.rm>) => {
      if (mockFsOps.failRm) return Promise.reject(new Error('rm 不可用'))
      return actual.rm(...args)
    }),
  }
})

// Deterministic discovery: the built-in candidate list is absolute system paths;
// existsSync returns whether the test put the candidate into the set. The
// hoisted copy must stay in sync with FREECAD_CMD_CANDIDATES (asserted below).
const mockFs = vi.hoisted(() => ({
  candidates: [
    '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd',
    '/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd',
    '/usr/bin/freecadcmd',
    '/usr/local/bin/freecadcmd',
    '/opt/homebrew/bin/freecadcmd',
    '/snap/bin/freecadcmd',
    'C:\\Program Files\\FreeCAD 1.1\\bin\\FreeCADCmd.exe',
    'C:\\Program Files\\FreeCAD\\bin\\FreeCADCmd.exe',
  ],
  existing: new Set<string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: ((p: unknown) => {
      const path = String(p)
      if (mockFs.candidates.includes(path)) return mockFs.existing.has(path)
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0])
    }) as typeof actual.existsSync,
  }
})

function handleWith(outcome: { exitCode: number | null; signal: NodeJS.Signals | null }, stderr = '', stdout = ''): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve(outcome),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

function fakeSubprocess(
  onSpawn: (_spec: SubprocessSpawnSpec) => SubprocessHandle,
): { runtime: SubprocessRuntime; calls: SubprocessSpawnSpec[] } {
  const calls: SubprocessSpawnSpec[] = []
  const runtime = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      calls.push(spec)
      return onSpawn(spec)
    },
  } as unknown as SubprocessRuntime
  return { runtime, calls }
}

function cleanEnv(): void {
  delete process.env.DSH_FREECAD_CMD
  mockFs.existing.clear()
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-freecad-'))
}

/** 写一个假的 freecadcmd 可执行文件，作为 override 路径（走真实 existsSync）。 */
function fakeFreecad(): { dir: string; exe: string } {
  const dir = tempDir()
  const exe = join(dir, 'freecadcmd')
  writeFileSync(exe, '')
  return { dir, exe }
}

function spec(overrides: Partial<StructureRenderSpec> = {}): StructureRenderSpec {
  return {
    modelPaths: ['/abs/model.step'],
    views: ['iso', 'front'],
    scale: 1,
    showHidden: false,
    callouts: [],
    figureNumber: 1,
    outputDir: tempDir(),
    ...overrides,
  }
}

afterEach(() => {
  cleanEnv()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('findFreeCadCmd', () => {
  it('测试候选清单与源码 FREECAD_CMD_CANDIDATES 保持一致', () => {
    expect(mockFs.candidates).toEqual([...FREECAD_CMD_CANDIDATES])
  })

  it('override 存在时优先使用（不存在则未找到，不回落）', () => {
    const { dir, exe } = fakeFreecad()
    try {
      expect(findFreeCadCmd(exe)).toBe(exe)
      expect(findFreeCadCmd(join(dir, 'missing'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('按 DSH_FREECAD_CMD → 候选路径 → PATH 顺序解析', () => {
    const { dir, exe } = fakeFreecad()
    try {
      process.env.DSH_FREECAD_CMD = exe
      expect(findFreeCadCmd()).toBe(exe)

      process.env.DSH_FREECAD_CMD = join(dir, 'missing')
      const candidate = mockFs.candidates[0] as string
      mockFs.existing.add(candidate)
      expect(findFreeCadCmd()).toBe(candidate)

      delete process.env.DSH_FREECAD_CMD
      mockFs.existing.clear()
      const originalPath = process.env.PATH
      process.env.PATH = dir + (originalPath === undefined ? '' : `:${originalPath}`)
      expect(findFreeCadCmd()).toBe(join(dir, 'freecadcmd'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PATH 未定义或含空段时安全跳过并回落', () => {
    const originalPath = process.env.PATH
    try {
      delete process.env.PATH
      expect(findFreeCadCmd()).toBeUndefined()
      process.env.PATH = ':'
      expect(findFreeCadCmd()).toBeUndefined()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })
})

describe('freecadInstallMessage', () => {
  it('未找到与路径失效分别给出引导', () => {
    expect(freecadInstallMessage(undefined)).toContain('FreeCAD')
    expect(freecadInstallMessage(undefined)).toContain('DSH_FREECAD_CMD')
    expect(freecadInstallMessage('/no/freecadcmd')).toContain('/no/freecadcmd')
  })
})

describe('probeFreeCad', () => {
  it('--version 成功时报告就绪与版本', async () => {
    const { exe } = fakeFreecad()
    const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }, '', 'FreeCAD 1.1.3 Revision: 20260725 (Git shallow)'))
    const result = await probeFreeCad(runtime, { executable: exe, probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(result.ready).toBe(true)
    expect(result.version).toBe('1.1.3')
    expect(calls[0]?.argv).toEqual([exe, '--version'])
  })

  it('--version 成功但无版本号时仍就绪', async () => {
    const { exe } = fakeFreecad()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }, '', 'FreeCAD'))
    const result = await probeFreeCad(runtime, { executable: exe, probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(result).toEqual({ ready: true, executable: exe })
  })

  it('非零退出、信号终止与 spawn 异常时报告未就绪', async () => {
    const { exe } = fakeFreecad()
    const failed = await probeFreeCad(fakeSubprocess(() => handleWith({ exitCode: 1, signal: null }, 'bad')).runtime, { executable: exe, probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(failed.ready).toBe(false)
    expect(failed.message).toContain('退出码 1')

    const signalled = await probeFreeCad(fakeSubprocess(() => handleWith({ exitCode: null, signal: 'SIGTERM' })).runtime, { executable: exe, probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(signalled.ready).toBe(false)
    expect(signalled.message).toContain('退出码 未知')

    const caught = await probeFreeCad(fakeSubprocess(() => { throw new Error('boom') }).runtime, { executable: exe, probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(caught.ready).toBe(false)
    expect(caught.message).toContain('boom')

    const caughtPlain = await probeFreeCad(fakeSubprocess(() => { throw 'plain-boom' }).runtime, { executable: exe, probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(caughtPlain.ready).toBe(false)
    expect(caughtPlain.message).toContain('plain-boom')
  })

  it('找不到可执行文件时返回安装引导', async () => {
    const dir = tempDir()
    try {
      process.env.PATH = dir
      const result = await probeFreeCad(
        fakeSubprocess(() => handleWith({ exitCode: 0, signal: null })).runtime,
        { probeTimeoutMs: TEST_PROBE_TIMEOUT_MS },
      )
      expect(result.ready).toBe(false)
      expect(result.message).toContain('FreeCAD')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderStructureViews', () => {
  it('成功：写脚本、隔离 env、返回 manifest 路径', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      let scriptAtSpawn = ''
      const { runtime, calls } = fakeSubprocess((spawnSpec) => {
        // 模拟 FreeCAD 子进程：在 cwd（=outputDir）写出 manifest.json 后退出 0。
        scriptAtSpawn = readFileSync(spawnSpec.argv[1] as string, 'utf8')
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_MANIFEST_FILENAME), '{"views":[{"name":"iso"}]}')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toEqual({ ok: true, manifestPath: join(outputDir, STRUCTURE_MANIFEST_FILENAME) })

      const call = calls[0]!
      expect(call.argv[0]).toBe(exe)
      expect((call.argv[1] as string).endsWith('.py')).toBe(true)
      expect(call.cwd).toBe(outputDir)
      // 子进程 HOME/缓存/临时目录隔离到 outputDir 内子目录
      expect(call.env?.HOME).toBe(join(outputDir, '.freecad-home'))
      expect(call.env?.XDG_CACHE_HOME).toContain(outputDir)
      expect(call.graceMs).toBe(3_000)
      // 脚本在 spawn 时已写入且含实测 API
      expect(scriptAtSpawn).toContain('TechDraw.viewPartAsSvg')
      // 渲染结束后隔离目录与脚本都清掉，不在交付目录留下隐藏残留
      expect(existsSync(join(outputDir, '.freecad-home'))).toBe(false)
      expect(existsSync(call.argv[1] as string)).toBe(false)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('清理结构脚本写入的模板与 transient 目录', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_MANIFEST_FILENAME), '{"views":[]}')
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_TEMPLATE_FILENAME), '<svg/>')
        mkdirSync(join(spawnSpec.cwd, STRUCTURE_TRANSIENT_DIRNAME), { recursive: true })
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_TRANSIENT_DIRNAME, 'part.svg'), '<svg/>')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      expect(existsSync(join(outputDir, STRUCTURE_TEMPLATE_FILENAME))).toBe(false)
      expect(existsSync(join(outputDir, STRUCTURE_TRANSIENT_DIRNAME))).toBe(false)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('隔离目录清理失败时仍返回渲染结果', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    mockFsOps.failRm = true
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_MANIFEST_FILENAME), '{"views":[]}')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      // 残留只是磁盘噪音：不能把已成功的渲染改判为失败。
      expect(result.ok).toBe(true)
    } finally {
      mockFsOps.failRm = false
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('outputDir 不存在时自动创建', async () => {
    const { exe } = fakeFreecad()
    const base = tempDir()
    const outputDir = join(base, 'nested', 'fig1')
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_MANIFEST_FILENAME), '{"views":[]}')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      expect(existsSync(outputDir)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('未安装时返回 not_installed', async () => {
    const dir = tempDir()
    try {
      process.env.PATH = dir
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderStructureViews(runtime, spec({ outputDir: dir }), { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'not_installed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非零退出回传 stderr 摘录（cfg/transcoder 告警非致命，仅退出码判定）', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 1, signal: null }, 'Traceback: RuntimeError 投影未产生任何几何'))
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'render_failed' })
      expect((result as { error: string }).error).toContain('退出码 1')
      expect((result as { error: string }).error).toContain('投影未产生任何几何')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('退出 0 但未生成 manifest 时报 render_failed', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'render_failed' })
      expect((result as { error: string }).error).toContain('未生成 manifest')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('被信号终止且无调用方取消时报告 render_failed', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: null, signal: null }))
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'render_failed' })
      expect((result as { error: string }).error).toContain('被信号 未知 终止')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('调用方取消且 spawn 抛错时分类为 aborted', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const caller = new AbortController()
      const { runtime } = fakeSubprocess(() => {
        caller.abort()
        throw new Error('boom')
      })
      const result = await renderStructureViews(
        runtime,
        spec({ outputDir, signal: caller.signal }),
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'aborted' })
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('非 Error 抛出也分类为 render_failed', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess(() => { throw 'plain-boom' })
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'render_failed' })
      expect((result as { error: string }).error).toContain('plain-boom')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('预中止信号传入子进程', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const caller = new AbortController()
      caller.abort()
      const { runtime, calls } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, STRUCTURE_MANIFEST_FILENAME), '{"views":[]}')
        return handleWith({ exitCode: 0, signal: null })
      })
      await renderStructureViews(
        runtime,
        spec({ outputDir, signal: caller.signal }),
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(calls[0]?.signal?.aborted).toBe(true)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('渲染超时（内部计时器）分类为 render_failed', async () => {
    vi.useFakeTimers()
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      let signal: AbortSignal | undefined
      const { runtime } = fakeSubprocess((spawnSpec) => {
        signal = spawnSpec.signal
        mkdirSync(spawnSpec.cwd, { recursive: true })
        return {
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          control: undefined,
          collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
          done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
          }),
          terminate() {},
          waitForExit: () => Promise.resolve(true),
        }
      })
      const pending = renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: INJECTED_RENDER_TIMEOUT_MS })
      vi.advanceTimersByTime(INJECTED_RENDER_TIMEOUT_MS)
      const result = await pending
      expect(result).toMatchObject({ ok: false, code: 'render_failed' })
      expect((result as { error: string }).error).toContain('渲染超时')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('脚本准备失败（输出目录被同名文件占用）时报 render_failed', async () => {
    const { exe } = fakeFreecad()
    const base = tempDir()
    const outputDir = join(base, 'blocked')
    try {
      writeFileSync(outputDir, 'not a directory')
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderStructureViews(runtime, spec({ outputDir }), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'render_failed' })
      expect((result as { error: string }).error).toContain('准备 FreeCAD 脚本失败')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('调用方取消且子进程非零退出时分类为 aborted', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const caller = new AbortController()
      const { runtime } = fakeSubprocess(() => {
        caller.abort()
        return handleWith({ exitCode: 1, signal: null }, 'boom')
      })
      const result = await renderStructureViews(
        runtime,
        spec({ outputDir, signal: caller.signal }),
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'aborted' })
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})

/** 正方形材料区域（视图帧毫米）。 */
const SECTION_REGION: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]]

/** 一次合法的剖切请求参数。 */
function sectionPlane(): { origin: [number, number, number]; normal: [number, number, number] } {
  return { origin: [0, 0, 0], normal: [0, 0, 1] }
}

describe('renderSectionGeometry', () => {
  it('未安装时返回 not_installed', async () => {
    const dir = tempDir()
    try {
      process.env.PATH = dir
      const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderSectionGeometry(
        runtime,
        { modelPath: '/abs/model.step', plane: sectionPlane(), outputDir: dir },
        { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'not_installed' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('剖切平面非法时报 geometry_failed，不启动子进程', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderSectionGeometry(
        runtime,
        {
          modelPath: '/abs/model.step',
          plane: { origin: [0, 0, 0], normal: [0, 0, 1], reference: [0, 0, 2] },
          outputDir,
        },
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'geometry_failed' })
      expect((result as { error: string }).error).toContain('平行')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('调用方取消且子进程非零退出时分类为 aborted', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const caller = new AbortController()
      const { runtime } = fakeSubprocess(() => {
        caller.abort()
        return handleWith({ exitCode: 1, signal: null }, 'boom')
      })
      const result = await renderSectionGeometry(
        runtime,
        { modelPath: '/abs/model.step', plane: sectionPlane(), outputDir, signal: caller.signal },
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'aborted' })
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('产物不是合法 JSON 时报 geometry_failed 并带上产物路径', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, SECTION_GEOMETRY_FILENAME), 'not json')
        return handleWith({ exitCode: 0, signal: null })
      })
      const signal = new AbortController().signal
      const result = await renderSectionGeometry(
        runtime,
        { modelPath: '/abs/model.step', plane: sectionPlane(), outputDir, signal },
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'geometry_failed' })
      expect((result as { error: string }).error).toContain('剖切几何产物不可用')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('产物结构非法时报 SectionGeometryError 的原文', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, SECTION_GEOMETRY_FILENAME), '{"rings":[]}')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderSectionGeometry(
        runtime,
        { modelPath: '/abs/model.step', plane: sectionPlane(), outputDir },
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'geometry_failed' })
      expect((result as { error: string }).error).toContain('剖切产物不含任何轮廓环')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('子进程非零退出且未取消时归入 geometry_failed', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 1, signal: null }, 'boom'))
      const result = await renderSectionGeometry(
        runtime,
        { modelPath: '/abs/model.step', plane: sectionPlane(), outputDir },
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'geometry_failed' })
      expect((result as { error: string }).error).toContain('FreeCAD 剖切几何失败')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})

describe('renderSectionHatch', () => {
  function hatchSpec(outputDir: string, overrides: Partial<SectionHatchSpec> = {}): SectionHatchSpec {
    return { regions: [{ outline: SECTION_REGION }], angleDeg: 45, spacingMm: 3, outputDir, ...overrides }
  }

  it('未安装时返回 not_installed', async () => {
    const dir = tempDir()
    try {
      process.env.PATH = dir
      const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderSectionHatch(runtime, hatchSpec(dir), { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'not_installed' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('剖面线参数非法时报 hatch_failed，不启动子进程', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
      const result = await renderSectionHatch(runtime, hatchSpec(outputDir, { angleDeg: 0 }), {
        executable: exe,
        renderTimeoutMs: TEST_RENDER_TIMEOUT_MS,
      })
      expect(result).toMatchObject({ ok: false, code: 'hatch_failed' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('调用方取消且子进程非零退出时分类为 aborted', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const caller = new AbortController()
      const { runtime } = fakeSubprocess(() => {
        caller.abort()
        return handleWith({ exitCode: 1, signal: null }, 'boom')
      })
      const result = await renderSectionHatch(runtime, hatchSpec(outputDir, { signal: caller.signal }), {
        executable: exe,
        renderTimeoutMs: TEST_RENDER_TIMEOUT_MS,
      })
      expect(result).toMatchObject({ ok: false, code: 'aborted' })
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('产物不是合法 JSON 时报 hatch_failed 并带上产物路径', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, HATCH_GEOMETRY_FILENAME), 'not json')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderSectionHatch(runtime, hatchSpec(outputDir), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'hatch_failed' })
      expect((result as { error: string }).error).toContain('剖面线产物不可用')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('产物结构非法时报 HatchGeometryError 的原文', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess((spawnSpec) => {
        writeFileSync(join(spawnSpec.cwd, HATCH_GEOMETRY_FILENAME), '{"regions":[]}')
        return handleWith({ exitCode: 0, signal: null })
      })
      const result = await renderSectionHatch(runtime, hatchSpec(outputDir), { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toMatchObject({ ok: false, code: 'hatch_failed' })
      expect((result as { error: string }).error).toContain('与请求的 1 个不符')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('显式 direction 透传，子进程非零退出且未取消时归入 hatch_failed', async () => {
    const { exe } = fakeFreecad()
    const outputDir = tempDir()
    try {
      const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 1, signal: null }, 'boom'))
      const result = await renderSectionHatch(
        runtime,
        hatchSpec(outputDir, { direction: 'backward' }),
        { executable: exe, renderTimeoutMs: TEST_RENDER_TIMEOUT_MS },
      )
      expect(result).toMatchObject({ ok: false, code: 'hatch_failed' })
      expect((result as { error: string }).error).toContain('FreeCAD 剖面线失败')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
