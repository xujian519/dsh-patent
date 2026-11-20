import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS,
  INKSCAPE_CANDIDATES,
  exportWithInkscape,
  findInkscape,
  inkscapeInstallMessage,
  outlineSvgText,
} from '../src/figure/inkscape-renderer.ts'
import type { SubprocessSpawner } from '../src/figure/subprocess-render.ts'

/** 用例显式声明的转换预算（毫秒）；生产由宿主 Config.inkscapeRenderTimeoutMs 解析后注入。 */
const TEST_RENDER_TIMEOUT_MS = DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS

// Deterministic discovery: the built-in candidate list is absolute system paths;
// existsSync returns whether the test put the candidate into the set (the
// hoisted copy must stay in sync with INKSCAPE_CANDIDATES, asserted below).
const mockFs = vi.hoisted(() => ({
  candidates: [
    '/opt/homebrew/bin/inkscape',
    '/usr/local/bin/inkscape',
    '/usr/bin/inkscape',
    '/snap/bin/inkscape',
    '/Applications/Inkscape.app/Contents/MacOS/inkscape',
    'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
    'C:\\Program Files (x86)\\Inkscape\\bin\\inkscape.exe',
  ],
  existing: new Set<string>(),
}))

// 原子写可被单次置为失败：用于验证「写回失败不留下半个文件」这条路径（不靠文件权限，
// 以管理员身份或 Windows 上同样可复现）。
const mockAtomic = vi.hoisted(() => ({ fail: false }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: (file: string, data: string, options: { mode: number }) =>
      mockAtomic.fail ? Promise.reject(new Error('EACCES')) : actual.writeFileAtomic(file, data, options),
  }
})

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

// 读取失败可被单次置为「非 Error 拒绝」、临时目录清理可被置为失败：分别验证
// 非 Error 文案分支与「清理失败不顶掉转换结果」的收尾分支。
const mockFsOps = vi.hoisted(() => ({ failReadPath: '', failRm: false, failMkdtemp: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === mockFsOps.failReadPath) {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- drives the non-Error rejection branch
        return Promise.reject('plain-read-boom')
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile,
    rm: ((...args: Parameters<typeof actual.rm>) => {
      if (mockFsOps.failRm) return Promise.reject(new Error('rm 不可用'))
      return actual.rm(...args)
    }),
    mkdtemp: ((...args: Parameters<typeof actual.mkdtemp>) => {
      if (mockFsOps.failMkdtemp) return Promise.reject(new Error('mkdtemp 不可用'))
      return actual.mkdtemp(...args)
    }) as typeof actual.mkdtemp,
  }
})

// assertSafeSvg 的契约只抛 SvgAnnotateError；带标记的产物用以验证「非该类错误」的
// 文案分支（依赖方违约时的防御路径）。
const mockSvg = vi.hoisted(() => ({ plainThrowMarker: '' }))

vi.mock('../src/figure/svg-annotate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/figure/svg-annotate.ts')>()
  return {
    ...actual,
    assertSafeSvg: (text: string, maxBytes: number) => {
      if (mockSvg.plainThrowMarker !== '' && text.includes(mockSvg.plainThrowMarker)) throw 'plain-svg-boom'
      actual.assertSafeSvg(text, maxBytes)
    },
  }
})

/** 已生成图形的样本（画布尺寸与线宽是转换必须保留的值）。 */
function sampleSvg(text = '<text x="1" y="2" font-size="3">接地</text>'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="20mm" viewBox="0 0 30 20">',
    `  <g fill="none" stroke="#000000" stroke-width="0.35"><line x1="1" y1="1" x2="5" y2="5" stroke-width="0.25"/>${text}</g>`,
    '</svg>',
    '',
  ].join('\n')
}

/** 转换产物样本：文字已换成路径。 */
const OUTLINED = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="20mm" viewBox="0 0 30 20">',
  '  <g fill="none" stroke="#000000" stroke-width="0.35"><line x1="1" y1="1" x2="5" y2="5" stroke-width="0.25"/><path d="M 1 2 h 3 v 3 z"/></g>',
  '</svg>',
  '',
].join('\n')

function handleWith(outcome: { exitCode: number | null; signal: NodeJS.Signals | null }, stderr = ''): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve(outcome),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

/**
 * 假 subprocess：记录 spawn 规格，并在每次 spawn 时按需伪造产物文件。
 * @param onSpawn - 收到 spawn 规格后返回句柄；可在此写产物文件。
 * @returns 运行时与调用记录。
 */
function fakeSubprocess(
  onSpawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
): { runtime: SubprocessSpawner; calls: SubprocessSpawnSpec[] } {
  const calls: SubprocessSpawnSpec[] = []
  const runtime = {
    spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
      calls.push(spec)
      return onSpawn(spec)
    },
  }
  return { runtime, calls }
}

/** 从 spawn 规格里取出 `--export-filename=` 指向的产物路径。 */
function outputPathOf(spec: SubprocessSpawnSpec): string {
  const flag = spec.argv.find(argument => argument.startsWith('--export-filename='))
  if (flag === undefined) throw new Error('spawn 规格里没有 --export-filename')
  return flag.slice('--export-filename='.length)
}

const dirs: string[] = []
afterEach(() => {
  mockFs.existing.clear()
  mockAtomic.fail = false
  mockFsOps.failReadPath = ''
  mockFsOps.failRm = false
  mockFsOps.failMkdtemp = false
  mockSvg.plainThrowMarker = ''
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个已生成图形的临时文件。 */
function figureFile(body = sampleSvg()): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-outline-spec-'))
  dirs.push(dir)
  const path = join(dir, 'fig1.svg')
  writeFileSync(path, body, 'utf8')
  return path
}

describe('findInkscape', () => {
  it('候选路径表与用例副本一致', () => {
    expect([...INKSCAPE_CANDIDATES]).toEqual(mockFs.candidates)
  })

  it('覆盖路径不存在时不回落自动探测', () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    expect(findInkscape('/nope/inkscape')).toBeUndefined()
    expect(findInkscape('/opt/homebrew/bin/inkscape')).toBe('/opt/homebrew/bin/inkscape')
    expect(findInkscape()).toBe('/opt/homebrew/bin/inkscape')
    expect(findInkscape('')).toBe('/opt/homebrew/bin/inkscape')
  })

  it('环境变量与候选路径都缺失时返回 undefined', () => {
    const previous = process.env.DSH_INKSCAPE
    process.env.DSH_INKSCAPE = '/nope/inkscape'
    try {
      expect(findInkscape()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.DSH_INKSCAPE
      else process.env.DSH_INKSCAPE = previous
    }
  })

  it('安装引导给出缺失提示与开启开关的退路', () => {
    expect(inkscapeInstallMessage(undefined)).toContain('未找到 Inkscape')
    expect(inkscapeInstallMessage('/x/inkscape')).toContain('已配置路径 /x/inkscape')
    expect(inkscapeInstallMessage(undefined)).toContain('Config.figureTextToPath')
  })
})

describe('outlineSvgText', () => {
  it('未安装 Inkscape 时返回 not_installed 且不改写文件', async () => {
    const path = figureFile()
    const before = readFileSync(path, 'utf8')
    const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'not_installed' })
    expect(calls).toHaveLength(0)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('转换成功时就地改写文件，argv 直传且输出写临时目录', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const { runtime, calls } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), OUTLINED, 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toEqual({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe(OUTLINED)
    const call = calls[0] as SubprocessSpawnSpec
    expect(call.argv.slice(1, 4)).toEqual(['--export-type=svg', '--export-plain-svg', '--export-text-to-path'])
    expect(call.argv.at(-1)).toBe(path)
    // 产物写在临时目录（不与图形同目录），且转换后临时目录被清理。
    const outputPath = outputPathOf(call)
    expect(outputPath.startsWith(tmpdir())).toBe(true)
    expect(existsSync(outputPath)).toBe(false)
    expect(call.stdio?.stdin).toBe('ignore')
  })

  it('产物仍含 <text> 时报 render_failed，绝不交出仍有字体依赖的文件', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const before = readFileSync(path, 'utf8')
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), sampleSvg(), 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('仍含 `<text>`')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('产物含实体或 CDATA 时按安全校验拒绝', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), '<svg xmlns="http://www.w3.org/2000/svg"><g><![CDATA[x]]></g></svg>', 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('SVG 校验失败')
  })

  it('产物几何走样时报 render_failed，原文件不改写', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const before = readFileSync(path, 'utf8')
    const { runtime } = fakeSubprocess((spec) => {
      // 产物把图形整体挪到画布外：几何护栏必须拦下（否则会静默替换掉一张好图）。
      writeFileSync(outputPathOf(spec), OUTLINED.replace('<line x1="1" y1="1" x2="5" y2="5" stroke-width="0.25"/>', '<line x1="90" y1="90" x2="95" y2="95" stroke-width="0.25"/>'), 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('几何走样')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('产物里没有可量测图形时报 render_failed', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const before = readFileSync(path, 'utf8')
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="20mm" viewBox="0 0 30 20"></svg>', 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('没有可量测的图形')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('原图与产物都没有可量测图形时按几何一致放行', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const EMPTY = '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="20mm" viewBox="0 0 30 20"></svg>'
    const path = figureFile(EMPTY)
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), EMPTY, 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    expect(await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })).toEqual({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe(EMPTY)
  })

  it('原图没有可量测图形、产物有时按几何一致放行（不因新增墨迹拒收）', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const EMPTY = '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="20mm" viewBox="0 0 30 20"></svg>'
    const path = figureFile(EMPTY)
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), OUTLINED, 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    expect(await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })).toEqual({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe(OUTLINED)
  })

  it('读取待转换文件被非 Error 拒绝时按 String(error) 报错', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    mockFsOps.failReadPath = join(tmpdir(), 'dsh-outline-plain-read.svg')
    const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const outcome = await outlineSvgText(runtime, { path: mockFsOps.failReadPath }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('读取待转换的 SVG 失败：plain-read-boom')
    expect(calls).toHaveLength(0)
  })

  it('SVG 校验抛非 SvgAnnotateError 时按 String(error) 报错', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    mockSvg.plainThrowMarker = 'plain-svg-marker'
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), OUTLINED.replace('</svg>', '<desc>plain-svg-marker</desc></svg>'), 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('SVG 校验失败：plain-svg-boom')
  })

  it('临时目录清理失败不顶掉转换结果', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    mockFsOps.failRm = true
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), OUTLINED, 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    expect(await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })).toEqual({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe(OUTLINED)
  })

  it('临时目录创建失败时报 render_failed（收尾不清理不存在的目录）', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    mockFsOps.failMkdtemp = true
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('mkdtemp 不可用')
  })

  it('写回失败时报 render_failed，原文件保持原样', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const before = readFileSync(path, 'utf8')
    mockAtomic.fail = true
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), OUTLINED, 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('EACCES')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('待转换文件读不到时报 render_failed，不启动子进程', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const outcome = await outlineSvgText(runtime, { path: join(tmpdir(), 'dsh-outline-missing.svg') }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('读取待转换的 SVG 失败')
    expect(calls).toHaveLength(0)
  })

  it('子进程退出后、写回前被取消：不改写文件并报 aborted', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const before = readFileSync(path, 'utf8')
    const controller = new AbortController()
    const { runtime } = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), OUTLINED, 'utf8')
      controller.abort()
      return handleWith({ exitCode: 0, signal: null })
    })
    const outcome = await outlineSvgText(runtime, { path, signal: controller.signal }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'aborted' })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('退出码非零时报 render_failed 并带上 stderr', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 1, signal: null }, 'boom'))
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('退出码 1')
    expect(outcome.ok ? '' : outcome.error).toContain('boom')
  })

  it('未生成产物文件时报 render_failed', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('未生成输出文件')
  })

  it('调用方取消时报 aborted', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const controller = new AbortController()
    controller.abort()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: null, signal: 'SIGTERM' }))
    const outcome = await outlineSvgText(runtime, { path, signal: controller.signal }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'aborted' })
  })

  it('spawn 抛错时报 render_failed', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    const runtime: SubprocessSpawner = {
      spawn: () => { throw new Error('spawn 不可用') },
    }
    const outcome = await outlineSvgText(runtime, { path }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('spawn 不可用')
  })

  it('渲染超时（内部计时器）分类为 render_failed', async () => {
    // Inkscape 在 spawn 前有 await readFile / mkdtemp（真实异步 fs），fake clock 无法
    // 可靠推进到 spawn 之后再触发 deadline，故用真实时钟：超时自 deadline 注册时起算，
    // 等待量远大于超时，留出余量让 fs 与 spawn 先完成。
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const path = figureFile()
    let signal: AbortSignal | undefined
    const { runtime } = fakeSubprocess((spawnSpec) => {
      signal = spawnSpec.signal
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
        }),
        terminate() {},
        waitForExit: () => Promise.resolve(true),
      }
    })
    const pending = outlineSvgText(runtime, { path }, { renderTimeoutMs: 30 })
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: false, code: 'render_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('渲染超时')
  })
})

describe('exportWithInkscape', () => {
  /** 结构完整的 PNG 产物（签名 + IEND 收尾）。 */
  const COMPLETE_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDRpayload'),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ])

  /** 结构完整的 PDF 产物（有 xref 指针、以 %%EOF 收尾）。 */
  const COMPLETE_PDF = Buffer.from('%PDF-1.5\n4 0 obj\n<< >>\nendobj\nstartxref\n9\n%%EOF\n', 'latin1')

  /** 造一个待导出的 SVG 与一个导出目标路径。 */
  function exportPaths(format: 'png' | 'pdf' = 'png'): { source: string; outcome: string } {
    const source = figureFile()
    return { source, outcome: join(dirname(source), `fig1.${format}`) }
  }

  /** 写出与格式相符的完整产物。 */
  function writeProduct(spec: SubprocessSpawnSpec): void {
    writeFileSync(outputPathOf(spec), spec.argv.includes('--export-type=pdf') ? COMPLETE_PDF : COMPLETE_PNG)
  }

  it('Inkscape 缺失时报 not_installed 且不 spawn', async () => {
    const { source, outcome } = exportPaths()
    const { runtime, calls } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const result = await exportWithInkscape(runtime, { path: source, outcomePath: outcome, format: 'png' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(result).toMatchObject({ ok: false, code: 'not_installed' })
    expect(calls).toHaveLength(0)
  })

  it('命令行按页面范围导出，dpi 只在给出时追加', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const { source, outcome } = exportPaths()
    const { runtime, calls } = fakeSubprocess((spec) => {
      writeProduct(spec)
      return handleWith({ exitCode: 0, signal: null })
    })
    expect(await exportWithInkscape(runtime, { path: source, outcomePath: outcome, format: 'png', dpi: 300 }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })).toEqual({ ok: true })
    expect(calls[0]?.argv).toEqual([
      '/opt/homebrew/bin/inkscape',
      '--export-type=png',
      '--export-area-page',
      '--export-dpi=300',
      `--export-filename=${outcome}`,
      source,
    ])
    // 工作目录取目标文件所在目录：目标路径可能是相对路径。
    expect(calls[0]?.cwd).toBe(dirname(outcome))
    const noDpi = await exportWithInkscape(runtime, { path: source, outcomePath: outcome, format: 'pdf' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(noDpi).toEqual({ ok: true })
    expect(calls[1]?.argv).not.toContain('--export-dpi=300')
    expect(calls[1]?.argv).toContain('--export-type=pdf')
  })

  it('退出码非零时报 render_failed 并带 stderr', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const { source, outcome } = exportPaths()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 1, signal: null }, 'unknown export type'))
    const result = await exportWithInkscape(runtime, { path: source, outcomePath: outcome, format: 'png' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(result).toMatchObject({ ok: false, code: 'render_failed' })
    expect(result.ok ? '' : result.error).toContain('unknown export type')
  })

  it('产物缺失或为空时报 render_failed（不把空文件当成功）', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const { source, outcome } = exportPaths()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: 0, signal: null }))
    const missing = await exportWithInkscape(runtime, { path: source, outcomePath: outcome, format: 'png' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(missing).toMatchObject({ ok: false, code: 'render_failed' })
    expect(missing.ok ? '' : missing.error).toContain('未生成有效的 png 产物')
    const emptyRuntime = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), '', 'utf8')
      return handleWith({ exitCode: 0, signal: null })
    })
    expect(await exportWithInkscape(emptyRuntime.runtime, { path: source, outcomePath: outcome, format: 'png' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }))
      .toMatchObject({ ok: false, code: 'render_failed' })
  })

  it('产物结构不完整时报 render_failed：退出码 0 也不算成功', async () => {
    // Inkscape 1.4.4 本机实测：图面含未转路径的某些中文字形时，PDF 在字体对象后被
    // 截断而退出码仍为 0；缺 IEND 的 PNG 同理。
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const pdf = exportPaths('pdf')
    const truncatedPdf = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), '%PDF-1.5\n4 0 obj\n<< >>\nendobj\n', 'latin1')
      return handleWith({ exitCode: 0, signal: null })
    })
    const pdfResult = await exportWithInkscape(truncatedPdf.runtime, { path: pdf.source, outcomePath: pdf.outcome, format: 'pdf' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(pdfResult).toMatchObject({ ok: false, code: 'render_failed' })
    expect(pdfResult.ok ? '' : pdfResult.error).toContain('产物不完整')
    expect(pdfResult.ok ? '' : pdfResult.error).toContain('figureTextToPath')
    const png = exportPaths()
    const truncatedPng = fakeSubprocess((spec) => {
      writeFileSync(outputPathOf(spec), COMPLETE_PNG.subarray(0, 12))
      return handleWith({ exitCode: 0, signal: null })
    })
    expect(await exportWithInkscape(truncatedPng.runtime, { path: png.source, outcomePath: png.outcome, format: 'png' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }))
      .toMatchObject({ ok: false, code: 'render_failed' })
  })

  it('调用方取消时报 aborted；spawn 抛错时报 render_failed', async () => {
    mockFs.existing.add('/opt/homebrew/bin/inkscape')
    const { source, outcome } = exportPaths()
    const controller = new AbortController()
    controller.abort()
    const { runtime } = fakeSubprocess(() => handleWith({ exitCode: null, signal: 'SIGTERM' }))
    expect(await exportWithInkscape(runtime, { path: source, outcomePath: outcome, format: 'pdf', signal: controller.signal }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }))
      .toMatchObject({ ok: false, code: 'aborted' })
    const throwing: SubprocessSpawner = { spawn: () => { throw new Error('spawn 不可用') } }
    const failed = await exportWithInkscape(throwing, { path: source, outcomePath: outcome, format: 'pdf' }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(failed).toMatchObject({ ok: false, code: 'render_failed' })
    expect(failed.ok ? '' : failed.error).toContain('spawn 不可用')
  })
})
