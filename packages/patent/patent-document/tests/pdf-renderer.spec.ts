import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PDF_TIMEOUT_MS, findChrome, renderPdf } from '@deepseek-ai/dsh-patent-document'
import { fakeSubprocess, successHandle } from './helpers.ts'

/** 用例显式声明的打印超时（毫秒）；生产由宿主 Config.pdfTimeoutMs 解析后注入。 */
const TEST_PDF_TIMEOUT_MS = DEFAULT_PDF_TIMEOUT_MS

/** 超时用例注入的非默认打印超时（毫秒）：证明期限取自注入值而非模块默认值。 */
const INJECTED_PDF_TIMEOUT_MS = 1_500

// Deterministic discovery: the built-in Chrome candidate list is absolute
// system paths that must not resolve differently on machines with Chrome
// installed. existsSync returns whether the test put a candidate into the set.
const mockFs = vi.hoisted(() => ({
  chromeCandidates: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    'C:\\Program Files\\Google Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  existingCandidates: new Set<string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: ((p: unknown) => {
      const path = String(p)
      if (mockFs.chromeCandidates.includes(path)) return mockFs.existingCandidates.has(path)
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0])
    }) as typeof actual.existsSync,
  }
})

// dirname('') never occurs for real absolute paths; the empty-dirname fallback
// is exercised through a marker path.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return {
    ...actual,
    dirname: (p: string) => (p.includes('__empty_dirname__') ? '' : actual.dirname(p)),
  }
})

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pdf-'))
}

afterEach(() => {
  vi.restoreAllMocks()
  mockFs.existingCandidates.clear()
})

describe('pdfRenderer', () => {
  it('renders a PDF by spawning headless Chrome through the subprocess seam', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime, calls } = fakeSubprocess((spec) => {
        const pdfArg = spec.argv.find(a => a.startsWith('--print-to-pdf='))
        if (pdfArg !== undefined) writeFileSync(pdfArg.slice('--print-to-pdf='.length), '%PDF-1.4')
        return successHandle()
      })

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result).toEqual({ ok: true, path: pdfPath })
      expect(existsSync(pdfPath)).toBe(true)

      expect(calls).toHaveLength(1)
      const argv = calls[0]?.argv ?? []
      expect(argv[0]).toBe(chromePath)
      expect(argv).toContain('--headless')
      expect(argv).toContain('--no-pdf-header-footer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to an error when no Chrome is discoverable', async () => {
    const dir = makeTempDir()
    try {
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime, calls } = fakeSubprocess(() => successHandle())
      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath: join(dir, 'missing-chrome'), pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('未找到 Chrome')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a failure when Chrome exits non-zero', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(() => ({
        ...successHandle(),
        done: Promise.resolve({ exitCode: 1, signal: null }),
      }))

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('Chrome PDF 打印失败')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a failure when Chrome exits 0 but writes no PDF', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(() => successHandle())
      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('Chrome 未生成 PDF')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not hand back a stale PDF from an earlier run', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')
      // 上一次渲染留下的同名产物：Chrome 这次退出 0 但没写文件时不能把它当本次结果。
      writeFileSync(pdfPath, 'stale pdf bytes')

      const { runtime } = fakeSubprocess(() => successHandle())
      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('Chrome 未生成 PDF')
      expect(existsSync(pdfPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('findChrome returns undefined for an explicitly missing override', () => {
    expect(findChrome('/no/such/chrome/binary')).toBeUndefined()
  })
})

describe('findChrome discovery', () => {
  it('returns undefined without an override, env, or existing candidate', () => {
    const env = { ...process.env } as Record<string, string | undefined>
    delete env.DSH_CHROME_PATH
    delete env.CHROME_PATH
    vi.spyOn(process, 'env', 'get').mockReturnValue(env)
    expect(findChrome()).toBeUndefined()
  })

  it('prefers DSH_CHROME_PATH when the file exists', () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      writeFileSync(chromePath, '')
      vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, DSH_CHROME_PATH: chromePath })
      expect(findChrome()).toBe(chromePath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls through to CHROME_PATH when DSH_CHROME_PATH is unset', () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      writeFileSync(chromePath, '')
      vi.spyOn(process, 'env', 'get').mockReturnValue({
        ...process.env,
        DSH_CHROME_PATH: undefined,
        CHROME_PATH: chromePath,
      })
      expect(findChrome()).toBe(chromePath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a missing env path and finds an existing built-in candidate', () => {
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, DSH_CHROME_PATH: '/no/such/chrome' })
    mockFs.existingCandidates.add('/usr/bin/chromium-browser')
    expect(findChrome()).toBe('/usr/bin/chromium-browser')
  })

  it('treats an empty-string override as no override', () => {
    const env = { ...process.env } as Record<string, string | undefined>
    delete env.DSH_CHROME_PATH
    delete env.CHROME_PATH
    vi.spyOn(process, 'env', 'get').mockReturnValue(env)
    expect(findChrome('')).toBeUndefined()
  })
})

describe('renderPdf process handling', () => {
  it('disables the Chrome sandbox when running as root', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')
      vi.spyOn(process, 'getuid').mockReturnValue(0)

      const { runtime, calls } = fakeSubprocess((spec) => {
        const pdfArg = spec.argv.find(a => a.startsWith('--print-to-pdf='))
        if (pdfArg !== undefined) writeFileSync(pdfArg.slice('--print-to-pdf='.length), '%PDF-1.4')
        return successHandle()
      })

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result).toEqual({ ok: true, path: pdfPath })
      expect(calls[0]?.argv).toContain('--no-sandbox')
      expect(calls[0]?.argv).toContain('--disable-setuid-sandbox')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the process cwd when the Chrome path has no directory', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, '__empty_dirname__', 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      mkdirSync(join(dir, '__empty_dirname__'), { recursive: true })
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')
      vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, DSH_CHROME_PATH: chromePath })

      const { runtime, calls } = fakeSubprocess((spec) => {
        const pdfArg = spec.argv.find(a => a.startsWith('--print-to-pdf='))
        if (pdfArg !== undefined) writeFileSync(pdfArg.slice('--print-to-pdf='.length), '%PDF-1.4')
        return successHandle()
      })

      const result = await renderPdf(runtime, htmlPath, pdfPath, { pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result).toEqual({ ok: true, path: pdfPath })
      expect(calls[0]?.cwd).toBe(process.cwd())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts the Chrome subprocess when the internal print timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const dir = makeTempDir()
      try {
        const chromePath = join(dir, 'chrome')
        const htmlPath = join(dir, 'doc.html')
        const pdfPath = join(dir, 'doc.pdf')
        writeFileSync(chromePath, '')
        writeFileSync(htmlPath, '<html></html>')

        let spawnedSignal: AbortSignal | undefined
        const { runtime } = fakeSubprocess((spec) => {
          spawnedSignal = spec.signal
          return successHandle()
        })

        const pending = renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: INJECTED_PDF_TIMEOUT_MS })
        expect(spawnedSignal).toBeDefined()
        vi.advanceTimersByTime(INJECTED_PDF_TIMEOUT_MS - 1)
        expect(spawnedSignal?.aborted).toBe(false)
        vi.advanceTimersByTime(1)
        expect(spawnedSignal?.aborted).toBe(true)
        await pending
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a caller abort during the render and skips spawn for a pre-aborted signal', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const caller = new AbortController()
      let duringSpawn: AbortSignal | undefined
      const { runtime } = fakeSubprocess((spec) => {
        duringSpawn = spec.signal
        caller.abort()
        return successHandle()
      })
      await renderPdf(runtime, htmlPath, pdfPath, { chromePath, signal: caller.signal, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(duringSpawn?.aborted).toBe(true)

      const preAborted = new AbortController()
      preAborted.abort()
      let preSpawn: AbortSignal | undefined
      const { runtime: runtime2 } = fakeSubprocess((spec) => {
        preSpawn = spec.signal
        return successHandle()
      })
      const result = await renderPdf(
        runtime2, htmlPath, pdfPath,
        { chromePath, signal: preAborted.signal, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS },
      )
      expect(preSpawn).toBeUndefined()
      expect(result).toEqual({ ok: false, error: '已取消：未启动 Chrome' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a signal-terminated Chrome with its signal name', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(() => ({
        ...successHandle(),
        done: Promise.resolve({ exitCode: null, signal: 'SIGKILL' as const }),
      }))

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('被信号 SIGKILL 终止')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the internal print timeout when Chrome is killed by the deadline', async () => {
    vi.useFakeTimers()
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(spec => ({
        ...successHandle(),
        done: new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => { resolve({ exitCode: 1, signal: null }) }, { once: true })
        }),
      }))

      const pending = renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: INJECTED_PDF_TIMEOUT_MS })
      vi.advanceTimersByTime(INJECTED_PDF_TIMEOUT_MS)
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('打印超时')
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the caller cancellation when it ends the print', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const caller = new AbortController()
      const { runtime } = fakeSubprocess(spec => ({
        ...successHandle(),
        done: new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => { resolve({ exitCode: 1, signal: null }) }, { once: true })
        }),
      }))

      const pending = renderPdf(runtime, htmlPath, pdfPath, { chromePath, signal: caller.signal, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      caller.abort()
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('被调用方取消')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an unknown terminating signal', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(() => ({
        ...successHandle(),
        done: Promise.resolve({ exitCode: null, signal: null }),
      }))

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('被信号 未知 终止')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an Error thrown by the subprocess seam', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(() => {
        throw new Error('spawn exploded')
      })

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('spawn exploded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a non-Error thrown by the subprocess seam', async () => {
    const dir = makeTempDir()
    try {
      const chromePath = join(dir, 'chrome')
      const htmlPath = join(dir, 'doc.html')
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(chromePath, '')
      writeFileSync(htmlPath, '<html></html>')

      const { runtime } = fakeSubprocess(() => {
        throw 'boom'
      })

      const result = await renderPdf(runtime, htmlPath, pdfPath, { chromePath, pdfTimeoutMs: TEST_PDF_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('boom')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
