/**
 * 附图渲染器选择器（`figureRenderer: 'wasm' | 'cli'`，默认 wasm）。
 *
 * wasm 路径走内置 @viz-js/viz 渲染器（无系统依赖）。WASM 构建仅含文本
 * 格式插件，png/pdf 由本选择器路由到 CLI 兜底（显式 cli 亦
 * 走同一 CLI 函数）。CLI 路径需要 subprocess 服务与 dot 可执行文件，未
 * 挂载/未安装时返回 `not_installed`，由工具层归并为 setup_required。
 *
 * WASM 的 `renderString` 是主线程上的同步调用、不可中断（取消信号只在调用前后各查一次），
 * 因此输入规模直接决定该次调用占用事件循环的最坏时长；超过引擎档位上限的 DOT 改走 CLI，
 * 由子进程的渲染期限（Config.graphvizRenderTimeoutMs）兜住。本机实测（@viz-js/viz 3.x，链式图）：`dot` 3000 个节点
 * 约 0.4 s，而强制导向引擎 800 个节点已需 3.4 s，叠加 `overlap=false`、`splines=true`
 * 后 800 个节点需 139 s。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/render-selector
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { DotEngine } from './dot-builder.ts'
import { renderWithGraphviz } from './graphviz-renderer.ts'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from './graphviz-renderer.ts'
import { renderWithVizWasm } from './viz-wasm-renderer.ts'

/** 渲染器模式：wasm=内置引擎（默认，SVG 零系统依赖）；cli=系统 dot 子进程。 */
export type FigureRendererMode = 'wasm' | 'cli'

/** 选择器依赖（仅 cli 与 png/pdf 回退路径需要）。 */
type FigureRendererSelectorDeps = {
  /** Cordis subprocess 服务；未挂载时 cli 路径返回 not_installed。 */
  subprocess?: SubprocessRuntime
  /** dot 可执行路径覆盖（与 Config.graphvizExecutable 同源）。 */
  graphvizExecutable?: string
  /** dot CLI 单次渲染超时（毫秒；与 Config.graphvizRenderTimeoutMs 同源）。 */
  graphvizRenderTimeoutMs: number
}

/** WASM 引擎无法产出的格式（png/pdf 无插件），一律走 CLI 兜底。 */
const CLI_FALLBACK_FORMATS: readonly string[] = ['png', 'pdf']

/** 强制导向引擎：迭代求解，规模敏感度远高于分层/环形/树形引擎（见模块文档实测）。 */
const FORCE_DIRECTED_ENGINES: readonly DotEngine[] = ['neato', 'fdp', 'sfdp']

/**
 * 强制导向引擎的 WASM 输入上限（按 `spec.dot.length` 计，即 UTF-16 码元）：实测 800 个节点
 * （36 000 长度）已需 3.4 s，远超可接受的同步占用。
 */
const WASM_MAX_FORCE_DOT_CHARS = 20_000

/** 分层/环形/树形引擎的 WASM 输入上限（同上按 DOT 文本长度计）：实测 3000 个节点约 0.4 s。 */
const WASM_MAX_HIERARCHICAL_DOT_CHARS = 64_000

/**
 * 判定是否改走 CLI：非文本格式无 WASM 插件；DOT 超过所在引擎档位的上限时，用子进程期限
 * 替代不可中断的同步渲染。
 * @param spec - 渲染请求。
 * @returns 需要 CLI 渲染时为 true。
 */
function needsCliRenderer(spec: GraphvizRenderSpec): boolean {
  if (CLI_FALLBACK_FORMATS.includes(spec.format)) return true
  const limit = FORCE_DIRECTED_ENGINES.includes(spec.engine) ? WASM_MAX_FORCE_DOT_CHARS : WASM_MAX_HIERARCHICAL_DOT_CHARS
  return spec.dot.length > limit
}

/**
 * 按配置选择渲染函数。
 * @param mode - 配置的渲染器模式；undefined 视为 'wasm'（默认）。
 * @param deps - subprocess 服务、dot 路径覆盖与渲染/探测超时。
 * @returns 与 renderWithGraphviz 同契约的渲染函数；超出 WASM 上限的输入按 `needsCliRenderer` 改走 CLI。
 */
export function pickRenderer(
  mode: FigureRendererMode | undefined,
  deps: FigureRendererSelectorDeps,
): (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> {
  const renderCli = (spec: GraphvizRenderSpec): Promise<GraphvizRenderOutcome> =>
    deps.subprocess === undefined
      ? Promise.resolve({ ok: false, code: 'not_installed', error: 'subprocess 服务不可用（未挂载 @deepseek-ai/dsh-subprocess）' })
      : renderWithGraphviz(deps.subprocess, spec, {
        ...(deps.graphvizExecutable === undefined ? {} : { executable: deps.graphvizExecutable }),
        renderTimeoutMs: deps.graphvizRenderTimeoutMs,
      })
  if (mode === 'cli') return renderCli
  return spec => (needsCliRenderer(spec) ? renderCli(spec) : renderWithVizWasm(spec))
}
