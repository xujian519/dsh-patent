/**
 * 附图外部渲染器（Graphviz / FreeCAD / Inkscape）共用的子进程样板：可执行文件解析、
 * stdio 上限、版本探测 spawn、渲染截止期与失败原因归类。
 *
 * 三个渲染器只在候选路径表、PATH 里的文件名、环境变量名与 argv / 产物校验上不同，
 * 共用部分必须保持同一条判定语义：探测与渲染共用同一 graceMs 与单流内存上限；渲染
 * 截止期让内部超时与调用方取消终止同一 AbortSignal；失败原因按「内部超时 → 调用方
 * 取消 → 信号终止 → 退出码」归类，内部超时优先（它同时中止了子进程）。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/subprocess-render
 */

import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/**
 * 只用 spawn 的 subprocess 依赖：外部渲染器里凡不碰其它服务的入口按最小依赖声明，
 * 调用方传完整 {@link SubprocessRuntime} 亦可，测试替身只实现 spawn 即可（不必把
 * 替身断言到 unknown）。
 */
export type SubprocessSpawner = Pick<SubprocessRuntime, 'spawn'>

/** 单流内存输出上限。 */
const MAX_OUTPUT_BYTES = 100_000

/** SIGTERM → SIGKILL 宽限（探测与渲染共用；与 patent-data subprocess-runner 一致）。 */
const SPAWN_GRACE_MS = 3_000

/** 可执行文件探测参数：三个渲染器只在候选表、PATH 文件名与环境变量名上不同。 */
type ExecutableLookup = {
  /** 显式覆盖路径（Config.<x>Executable）；提供时不存在则视为未找到，不回落自动探测。 */
  readonly override?: string
  /** 环境变量名（如 `DSH_GRAPHVIZ_DOT`）。 */
  readonly envVar: string
  /** 各平台常见安装路径（绝对路径）。 */
  readonly candidates: readonly string[]
  /** PATH 分段里查找的文件名（含 Windows 扩展名）。 */
  readonly names: readonly string[]
}

/**
 * 解析可执行文件路径：覆盖值 → 环境变量 → 平台候选路径 → PATH 分段。
 * @param lookup - 覆盖值、环境变量名、候选路径与文件名。
 * @returns 可执行文件绝对路径，或 undefined。
 */
export function findExecutable(lookup: ExecutableLookup): string | undefined {
  const { override, envVar, candidates, names } = lookup
  if (override !== undefined && override !== '') {
    return existsSync(override) ? override : undefined
  }
  const env = process.env[envVar]
  if (env !== undefined && env !== '' && existsSync(env)) return env
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  for (const name of names) {
    for (const segment of (process.env.PATH ?? '').split(delimiter)) {
      if (segment === '') continue
      const candidate = join(segment, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 无输入 spawn 的 stdio 配置（版本探测与 FreeCAD 渲染共用）。
 * @returns 忽略 stdin、按同一内存上限收集 stdout/stderr 的 stdio 配置。
 */
export function quietStdio(): SubprocessSpawnSpec['stdio'] {
  return {
    stdin: 'ignore',
    stdout: { maxBytes: MAX_OUTPUT_BYTES },
    stderr: { maxBytes: MAX_OUTPUT_BYTES },
  }
}

/**
 * 经 stdin 承载输入文本的 stdio 配置（Graphviz 渲染）。
 * @param data - 经 stdin 写入并关闭的文本；空串表示无输入。
 * @returns 在 {@link quietStdio} 基础上承载 `data` 的 stdio 配置。
 */
export function stdinStdio(data: string): SubprocessSpawnSpec['stdio'] {
  return { ...quietStdio(), stdin: data === '' ? 'ignore' : { data } }
}

/** 探测结果：退出事实与合并输出文本。 */
type VersionProbeResult = {
  /** 子进程退出事实。 */
  readonly outcome: SubprocessOutcome
  /** stdout 与 stderr 的合并文本（版本号从中提取）。 */
  readonly text: string
}

/**
 * 运行一次版本探测并等待退出（argv 直传，不经 shell；cwd 取可执行文件所在目录）。
 * @param subprocess - 注入的 subprocess 服务。
 * @param executable - 已解析的可执行文件绝对路径。
 * @param versionFlag - 版本开关（dot 用 `-V`，freecadcmd 用 `--version`）。
 * @param signal - 探测截止期信号。
 * @returns 退出事实与合并输出文本。
 */
export async function spawnVersionProbe(
  subprocess: SubprocessRuntime,
  executable: string,
  versionFlag: string,
  signal: AbortSignal,
): Promise<VersionProbeResult> {
  const handle = subprocess.spawn({
    argv: [executable, versionFlag],
    cwd: dirname(executable) || process.cwd(),
    stdio: quietStdio(),
    graceMs: SPAWN_GRACE_MS,
    signal,
  })
  const outcome = await handle.done
  return {
    outcome,
    text: `${handle.collected.stdout?.readFrom(0).text ?? ''} ${handle.collected.stderr?.readFrom(0).text ?? ''}`,
  }
}

/**
 * 在渲染期限内 spawn 外部渲染器并等待退出。
 *
 * 三个渲染器的 spawn 只差 argv、工作目录、stdio 与（FreeCAD 的）env：期限信号、
 * graceMs 与「spawn 后等退出」的次序必须一致，故由本函数统一给出。
 * @param subprocess - 注入的 subprocess 服务。
 * @param deadline - 渲染期限（提供终止信号）。
 * @param spec - argv、工作目录、stdio 与可选 env。
 * @returns 子进程句柄与退出事实。
 */
export async function spawnRenderProcess(
  subprocess: SubprocessSpawner,
  deadline: RenderDeadline,
  spec: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly stdio: SubprocessSpawnSpec['stdio']
    readonly env?: Record<string, string>
  },
): Promise<{ readonly handle: SubprocessHandle; readonly outcome: SubprocessOutcome }> {
  const handle = subprocess.spawn({
    argv: [...spec.argv],
    cwd: spec.cwd,
    stdio: spec.stdio,
    graceMs: SPAWN_GRACE_MS,
    signal: deadline.signal,
    ...(spec.env === undefined ? {} : { env: spec.env }),
  })
  return { handle, outcome: await handle.done }
}

/**
 * 归类渲染入口抛出的异常（spawn 失败、mkdtemp 失败等）：调用方取消 → aborted，
 * 其余 → render_failed；文案带渲染器名，便于用户定位是哪一步挂了。
 * @param tool - 渲染器名（写进文案，与「调用失败」连写，如 `Graphviz 渲染`）。
 * @param error - 抛出的值。
 * @param callerSignal - 调用方取消信号。
 * @returns 失败码与文案。
 */
export function describeRenderThrow(
  tool: string,
  error: unknown,
  callerSignal: AbortSignal | undefined,
): { readonly code: 'aborted' | 'render_failed'; readonly error: string } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: callerSignal?.aborted === true ? 'aborted' : 'render_failed',
    error: `${tool}调用失败：${message}`,
  }
}

/** 渲染截止期：内部超时与调用方取消终止同一信号。 */
export type RenderDeadline = {
  /** 交给 spawn 的终止信号。 */
  readonly signal: AbortSignal
  /** 内部超时是否触发。 */
  readonly timedOut: () => boolean
  /** 清理计时器与调用方监听；必须与创建成对调用。 */
  readonly dispose: () => void
}

/**
 * 启动渲染截止期。
 * @param timeoutMs - 内部超时（毫秒）。
 * @param callerSignal - 调用方取消信号（可缺省）。
 * @returns 截止期句柄：交给 spawn 的信号、超时查询与清理函数。
 */
export function startRenderDeadline(timeoutMs: number, callerSignal?: AbortSignal): RenderDeadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()
  const onCallerAbort = (): void => { controller.abort() }
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal?.aborted === true) controller.abort()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/**
 * 读取渲染子进程的 stderr 摘录。
 * @param handle - 渲染子进程句柄。
 * @returns 去除首尾空白的 stderr 文本；无 stderr 流或无非空输出时为空串。
 */
export function renderStderr(handle: SubprocessHandle): string {
  return (handle.collected.stderr?.readFrom(0).text ?? '').trim()
}

/**
 * 归类渲染失败原因（内部超时优先，其次是调用方取消、信号终止与退出码）。
 * @param outcome - 子进程退出事实。
 * @param timedOut - 内部超时是否触发。
 * @param callerSignal - 调用方取消信号（可缺省）。
 * @returns 面向用户的原因短语。
 */
export function describeRenderFailure(
  outcome: SubprocessOutcome,
  timedOut: boolean,
  callerSignal: AbortSignal | undefined,
): string {
  if (timedOut) return '渲染超时'
  if (callerSignal?.aborted === true) return '被调用方取消'
  if (outcome.exitCode === null) return `被信号 ${outcome.signal ?? '未知'} 终止`
  return `退出码 ${outcome.exitCode}`
}
