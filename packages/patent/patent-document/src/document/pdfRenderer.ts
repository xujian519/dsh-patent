/**
 * PDF 渲染：经 ctx.subprocess.spawn 调用系统 Chrome / Chromium 无头打印。
 *
 * 设计原则：不引入 puppeteer/playwright 等重型依赖；优先复用用户已安装的
 * Chrome / Chromium / Edge，找不到时返回降级结果让工具回退 HTML-only。
 * @module @deepseek-ai/dsh-patent-document/document/pdfRenderer
 */

import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startSpawnDeadline } from '@deepseek-ai/dsh-patent-core'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** 候选 Chrome 可执行路径（macOS / Linux / Windows）。 */
const CHROME_CANDIDATES: string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** 默认 Chrome 无头打印超时（毫秒）；Config.pdfTimeoutMs 的默认值。 */
export const DEFAULT_PDF_TIMEOUT_MS = 120_000

/** SIGTERM → SIGKILL 升级宽限（与 patent-data subprocess-runner 的 3s 一致）。 */
const GRACE_MS = 3_000

/** 单流内存输出上限（Chrome 诊断尾）。 */
const MAX_OUTPUT_BYTES = 100_000

/**
 * 返回可用的 Chrome 可执行路径，找不到返回 undefined。
 * @param override - 显式覆盖路径；提供时若文件不存在则视为未找到，不回落自动探测。
 * @returns Chrome 可执行文件绝对路径，或 undefined。
 */
export function findChrome(override?: string): string | undefined {
  if (override !== undefined && override !== '') {
    return existsSync(override) ? override : undefined
  }
  const env = process.env.DSH_CHROME_PATH ?? process.env.CHROME_PATH
  if (env && existsSync(env)) return env
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Chrome 沙箱标志：仅在 root 环境（Linux 容器/CI）下禁用沙箱；
 * 普通桌面用户保持沙箱开启，避免无谓降低 Chrome 安全姿态。
 */
function sandboxFlags(): string[] {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return ['--no-sandbox', '--disable-setuid-sandbox']
  }
  return []
}

/**
 * 调用 headless Chrome 将 HTML 打印为 PDF。
 * @param subprocess - 注入的 subprocess 服务（ctx.subprocess）。
 * @param htmlPath - 输入 HTML 绝对路径。
 * @param pdfPath - 输出 PDF 绝对路径。
 * @param options - Chrome 路径覆盖、调用方取消信号与打印超时。
 * @returns 成功时 { ok: true, path }，失败时 { ok: false, error }。
 */
export async function renderPdf(
  subprocess: SubprocessRuntime,
  htmlPath: string,
  pdfPath: string,
  options: { chromePath?: string; signal?: AbortSignal; pdfTimeoutMs: number },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const chrome = findChrome(options.chromePath)
  if (chrome === undefined) {
    return { ok: false, error: '未找到 Chrome/Chromium 可执行文件（可设置 DSH_CHROME_PATH）' }
  }

  const args = [
    '--headless',
    '--disable-gpu',
    ...sandboxFlags(),
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=5000',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ]

  // 已取消的调用不起进程：Chrome 启动成本高，且信号已中止时 spawn 只会抛一条
  // 与本包无关的 AbortError。用函数读取而不是直读，避免类型收窄让下方的
  // 「调用方取消」分支被判成不可达。
  const callerCancelled = (): boolean => options.signal?.aborted === true
  if (callerCancelled()) {
    return { ok: false, error: '已取消：未启动 Chrome' }
  }

  // 同名旧 PDF 会让「退出 0 且文件存在」骗过下面那次检查：先删掉，existsSync
  // 才能证明这次确实写出了新文件，而不是把上次的产物当本次结果交付。
  rmSync(pdfPath, { force: true })

  // Chrome 在 Windows 上返回的是 chrome.exe 而非目录，dirname 可能为空。
  const cwd = dirname(chrome) || process.cwd()
  const deadline = startSpawnDeadline(options.pdfTimeoutMs, options.signal)
  try {
    const handle = subprocess.spawn({
      argv: [chrome, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: GRACE_MS,
      signal: deadline.signal,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) {
      const stderr = (handle.collected.stderr?.readFrom(0).text ?? '').trim()
      const cause = deadline.timedOut()
        ? '打印超时'
        : callerCancelled()
          ? '被调用方取消'
          : outcome.exitCode === null
            ? `被信号 ${outcome.signal ?? '未知'} 终止`
            : `退出码 ${outcome.exitCode}`
      return { ok: false, error: `Chrome PDF 打印失败（${cause}）: ${stderr || '无 stderr 输出'}` }
    }
    if (!existsSync(pdfPath)) {
      return { ok: false, error: `Chrome 未生成 PDF: ${pdfPath}` }
    }
    return { ok: true, path: pdfPath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Chrome PDF 打印失败: ${message}` }
  } finally {
    deadline.dispose()
  }
}
