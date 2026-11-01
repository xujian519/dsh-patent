/**
 * 工作区内 SVG 输入的统一读入。
 *
 * 检查同一个接缝的两处（`add_patent_figure_references` 与 `verify_patent_figure`
 * 都把模型给的路径读成 SVG 文本）共享同一段前置：解析路径、按缺失与不可读分别报错、
 * 并在结果里回显同一对路径。集中在一处的目的是让两处的报错文案与路径口径不会各自
 * 漂移。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/svg-input
 */

import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { PatentToolError } from '../../error.ts'

/** 读入的 SVG 输入。 */
type SvgInput = {
  /** 绝对路径：被读文件可能不在工作区内，绝对路径是定位它的唯一口径。 */
  readonly absolutePath: string
  /** 工作区相对路径（结果回显用）。 */
  readonly path: string
  /** 文件文本。 */
  readonly svg: string
}

/**
 * 读入一个 SVG 文件。
 * @param svgPath - 模型给出的路径（工作区相对或绝对）。
 * @param cwd - 相对路径基准。
 * @param tool - 报错归属的工具名。
 * @returns 绝对路径、工作区相对路径与文本内容。
 * @throws PatentToolError('file_not_found') 路径不存在时（`ENOENT`/`ENOTDIR`）。
 * @throws PatentToolError('invalid_tool_input') 路径存在但读不出文本时（如指向目录、权限不足）。
 */
export async function readSvgInput(svgPath: string, cwd: string, tool: string): Promise<SvgInput> {
  const absolutePath = resolve(cwd, svgPath)
  let svg: string
  try {
    svg = await readFile(absolutePath, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new PatentToolError('file_not_found', `SVG 文件不存在：${svgPath}`, { tool })
    }
    // 路径存在却读不出文本（目录、权限、编码）：是输入指错了对象，报 invalid_tool_input
    // 并把系统原因带上，否则模型只会看到「不存在」而反复试同一条路径。
    throw new PatentToolError(
      'invalid_tool_input',
      `SVG 文件不可读：${svgPath}（${error instanceof Error ? error.message : String(error)}）`,
      { tool },
    )
  }
  return { absolutePath, path: relative(cwd, absolutePath), svg }
}

/** SVG 路径参数 schema（读入 SVG 的工具共用：参数名与描述口径一致）。 */
export const SVG_PATH_PARAM = {
  type: 'string',
  required: true,
  description: 'SVG 图片路径（工作区相对或绝对路径）',
} as const

/**
 * 结果里的路径字段 schema（读入 SVG 的工具共用）：相对路径与绝对路径成对返回 ——
 * 被读文件可能不在工作区内，只有绝对路径能定位它。
 */
export const SVG_PATH_RESULT_FIELDS = {
  path: { type: 'string', required: true },
  absolutePath: { type: 'string', required: true },
} as const
