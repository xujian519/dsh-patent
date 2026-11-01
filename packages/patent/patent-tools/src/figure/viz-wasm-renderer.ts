/**
 * 内置 WASM Graphviz 渲染器（@viz-js/viz，无系统二进制依赖）。
 *
 * 引擎经动态 import() 惰性加载（ESM 入口约 1.2MB，WASM 内联；实例进程内
 * 缓存，加载失败不缓存以便依赖修复后重试），在内存完成渲染后写盘。WASM
 * 构建仅含文本格式插件：svg 可渲染而 png/pdf 抛 "Format not recognized"，
 * 因此这两个格式由 render-selector 路由到 CLI 兜底，本渲染器不做回退。加载失败映射
 * outcome `not_installed`（文案指明内置引擎，工具层既有映射归并为 setup_required），
 * 渲染失败 `render_failed`，调用方取消 `aborted`，与 CLI 渲染器共用
 * GraphvizRenderOutcome 契约。
 *
 * `renderString` 在调用方线程上同步执行：调用期间事件循环停摆，取消信号只在调用前与
 * 写盘前各查一次，渲染本身无法中断。输入规模因此就是该次占用的上界，由
 * figure/render-selector 的引擎分档限制；需要可终止语义时把该 DOT 改由 CLI 子进程渲染。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/viz-wasm-renderer
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from './graphviz-renderer.ts'
import { sanitizeDotFilename } from './graphviz-renderer.ts'

/** viz 实例（@viz-js/viz 包）的最小接口：只声明 renderString，便于测试注入替身。 */
export type VizInstance = {
  /** 渲染 DOT 文本为字符串（仅文本格式；png/pdf 由 WASM 构建不支持而抛错）。 */
  renderString: (dot: string, options: { format: string; engine: string }) => string
}

/** 引擎加载器（默认动态 import('@viz-js/viz')；测试可注入失败/替身加载器）。 */
type VizLoader = () => Promise<VizInstance>

/** WASM 渲染器依赖。 */
type VizWasmRendererDeps = {
  /** 引擎加载器，缺省用默认动态加载（进程内缓存实例）。 */
  loadViz?: VizLoader
}

/**
 * 生成内置引擎加载失败的引导文案。
 * @param cause - 加载失败原因文本。
 * @returns 指明内置引擎与恢复路径的用户文案。
 */
export function vizLoadFailureMessage(cause: string): string {
  return [
    `内置 WASM Graphviz 渲染引擎（@viz-js/viz）加载失败：${cause}。`,
    '该引擎随依赖打包、无需系统安装；请重新安装依赖（pnpm install），或配置 figureRenderer="cli" 改用系统 Graphviz。',
  ].join('')
}

/** 进程内引擎实例缓存（Promise 形态避免并发重复加载）。 */
let engineInstance: Promise<VizInstance> | undefined

/** 默认加载器：动态 import 惰性加载并缓存实例；失败不缓存。 */
const loadVizInstance: VizLoader = async () => {
  engineInstance ??= import('@viz-js/viz').then(module => module.instance())
  try {
    return await engineInstance
  } catch (error) {
    engineInstance = undefined
    throw error
  }
}

/** 调用方取消的统一 outcome。 */
function abortedOutcome(): GraphvizRenderOutcome {
  return { ok: false, code: 'aborted', error: 'Graphviz WASM 渲染被调用方取消' }
}

/**
 * 构造内置 WASM 渲染函数（渲染前/加载后/写盘前检查取消信号）。
 * @param deps - 可选加载器覆盖（测试注入）。
 * @returns 与 renderWithGraphviz 同契约的渲染函数。
 */
export function createVizWasmRenderer(deps: VizWasmRendererDeps = {}): (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> {
  const loadViz = deps.loadViz ?? loadVizInstance
  return async (spec) => {
    // 局部谓词而非内联比较：同一可选链的重复 === 比较会触发 TS2367 收窄误报。
    const callerAborted = (): boolean => spec.signal?.aborted === true
    if (callerAborted()) return abortedOutcome()
    let viz: VizInstance
    try {
      viz = await loadViz()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'not_installed', error: vizLoadFailureMessage(message) }
    }
    if (callerAborted()) return abortedOutcome()
    const outputPath = join(spec.outputDir, `${sanitizeDotFilename(spec.filename)}.${spec.format}`)
    let output: string
    try {
      output = viz.renderString(spec.dot, { format: spec.format, engine: spec.engine })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (callerAborted()) return abortedOutcome()
      return { ok: false, code: 'render_failed', error: `Graphviz WASM 渲染失败：${message}` }
    }
    if (callerAborted()) return abortedOutcome()
    try {
      await writeFile(outputPath, output, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'render_failed', error: `Graphviz WASM 渲染输出写盘失败：${message}` }
    }
    return { ok: true, path: outputPath }
  }
}

/**
 * 用内置 WASM 引擎渲染 DOT 为图片文件（默认加载器）。
 * @param spec - 渲染规格：DOT 文本、输出文件名、格式、布局引擎与输出目录。
 * @returns 与 CLI 渲染器同契约的渲染结果。
 */
export const renderWithVizWasm: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> = createVizWasmRenderer()
