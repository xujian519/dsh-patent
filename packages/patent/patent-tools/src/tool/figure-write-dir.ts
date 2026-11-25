/**
 * 附图写入目录：显式 `outputDir` 优先；否则写入已解析案卷目录的 `04-撰写/`。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-write-dir
 */

import { resolvePatentOutputDir } from '@deepseek-ai/dsh-patent-core'
import { PatentToolError } from '../error.ts'

/** 附图随申请文件落在 patent-workspace-layout 已有的 `04-撰写/`。 */
const FIGURE_LAYOUT_DIR = '04-撰写' as const

/**
 * 解析一次附图写入目录。
 *
 * `outputDir` 是部署显式配置的绝对目录，可以在工作目录之外。未配置时按案卷目录解析，
 * 无法解析且没有覆盖时失败，不回落 `patent/figures`。
 * @param deps - 显式输出目录与 `workbenchCaseRoot`。
 * @param cwd - 本次调用的工作目录。
 * @param caseId - 调用方给出的案号。
 * @param tool - 错误详情里的工具名。
 * @returns 输出目录绝对路径。
 * @throws PatentToolError `invalid_tool_input` 当案卷目录无法解析且没有显式目录时。
 */
export function resolveFigureWriteDir(
  deps: { readonly outputDir?: string; readonly workRoot?: string },
  cwd: string,
  caseId: string | undefined,
  tool: string,
): string {
  if (deps.outputDir !== undefined) return deps.outputDir
  return resolvePatentOutputDir(
    caseId === undefined ? {} : { caseId },
    cwd,
    {
      layoutDir: FIGURE_LAYOUT_DIR,
      ...(deps.workRoot === undefined ? {} : { workRoot: deps.workRoot }),
    },
    message => new PatentToolError('invalid_tool_input', message, { tool }),
  )
}
