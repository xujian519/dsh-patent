/**
 * 申请文件出件插件：把结构化内容按模板体例成文为 CNIPA 申请文件 .docx，并对成品跑断言。
 *
 * 体例真相源是随包的 `assets/template/申请文件模板.docx`：字体、字号、行距、首行缩进、
 * 分节与页眉都由引擎从该文件反解，`assets/spec/申请文件.json` 的 style 块只作投影核对。
 * 要改体例就改模板；换模板时 `specPath` 也要一并核对（不一致会报错，不会静默套错体例）。
 * @module @deepseek-ai/dsh-patent-filing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ENGINE_TIMEOUT_MS, DEFAULT_OUTPUT_DIR } from './filing/engine.ts'
import { defaultSpecPath, defaultTemplatePath } from './filing/assets.ts'
import { findPython } from './filing/python.ts'
import { createBuildPatentFilingTool } from './tool/build-patent-filing.ts'
import { createVerifyPatentFilingTool } from './tool/verify-patent-filing.ts'

// Public library API: the engine runner, the tool factories, and the asset resolvers.
export * from './filing/assets.ts'
export * from './filing/content.ts'
export * from './filing/engine.ts'
export * from './filing/fromDraft.ts'
export * from './filing/python.ts'
export { createBuildPatentFilingTool, renderBuildResult } from './tool/build-patent-filing.ts'
export type { BuildPatentFilingToolOptions } from './tool/build-patent-filing.ts'
export { createVerifyPatentFilingTool, renderVerifyResult } from './tool/verify-patent-filing.ts'
export type { VerifyPatentFilingToolOptions } from './tool/verify-patent-filing.ts'
export { PatentFilingError } from './types.ts'
export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'patent-filing'

/** Services the plugin requires before registration. */
export const inject = ['tools', 'subprocess']

/** 申请文件出件插件的部署配置。 */
export interface Config {
  /** Python 解释器绝对路径；缺省按 DSH_PYTHON_PATH、随包运行时、PATH 顺序探测。 */
  pythonPath?: string
  /** Chrome 可执行文件绝对路径；`.svg` 附图栅格化用，缺省按 DSH_CHROME_PATH/CHROME_PATH/常见安装位置探测。 */
  chromePath?: string
  /** 体例真相源（模板 .docx）的绝对路径；缺省用随包模板。 */
  templatePath?: string
  /** 结构与断言定义（spec JSON）的绝对路径；缺省用随包 spec。换模板时必须一并核对。 */
  specPath?: string
  /** 缺省输出目录（相对进程工作目录）；既未给 outputDir 也未给 caseId 时使用。 */
  outputRoot: string
  /** `.svg` 附图栅格化倍率。 */
  figureScale: number
  /** 单次引擎调用超时（毫秒）。 */
  timeoutMs: number
}

/** Schemastery configuration: interpreter, template identity, output location, and engine bounds. */
export const Config: z<Partial<Config>, Config> = z.object({
  pythonPath: z.string(),
  chromePath: z.string(),
  templatePath: z.string(),
  specPath: z.string(),
  outputRoot: z.string().default(DEFAULT_OUTPUT_DIR),
  figureScale: z.number().step(1).min(1).default(3),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_ENGINE_TIMEOUT_MS),
})

/**
 * Register the build and verify tools.
 *
 * The interpreter is a host capability, not a deployment setting: when none is discoverable the
 * plugin still mounts and each tool call reports the missing interpreter, so one absent runtime
 * cannot take down a composition that mounts this row. An explicitly configured path that does
 * not exist is a self-contained misconfiguration and still fails here.
 * @param ctx - registrant context carrying the tool registry and subprocess service.
 * @param config - deployment's interpreter, template identity, output location, and engine bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const pythonPath = config.pythonPath !== undefined && config.pythonPath !== ''
    ? findPython(config.pythonPath)
    : undefined
  const templatePath = config.templatePath ?? defaultTemplatePath()
  const specPath = config.specPath ?? defaultSpecPath()
  const outputRoot = config.outputRoot
  const figureScale = config.figureScale
  const timeoutMs = config.timeoutMs
  ctx.tools.register(createBuildPatentFilingTool({
    subprocess: ctx.subprocess,
    ...(pythonPath !== undefined ? { pythonPath } : {}),
    specPath,
    templatePath,
    defaultOutputDir: outputRoot,
    figureScale,
    timeoutMs,
    ...(config.chromePath !== undefined ? { chromePath: config.chromePath } : {}),
  }))
  ctx.tools.register(createVerifyPatentFilingTool({
    subprocess: ctx.subprocess,
    ...(pythonPath !== undefined ? { pythonPath } : {}),
    specPath,
    templatePath,
    timeoutMs,
  }))
}
