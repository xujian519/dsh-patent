/**
 * 生成时渲染复核门禁：读回已写入的 SVG，把 findings 折成警告；strict 模式下把
 * 阻断级发现转成工具失败，文件保留供修正但不导出交付件。
 *
 * 两个生成工具（`generate_patent_figure` / `generate_structure_figure`）共用本门禁，
 * 因此阻断口径与 warnings 文案只有一处。复核位置由调用方决定：必须在落版之后、
 * 文字转路径之前——落版改写坐标与画布，转路径后图面已无 `<text>`。
 * @module @deepseek-ai/dsh-patent-tools/figure/render-check-gate
 */

import { readFile } from 'node:fs/promises'
import { PatentToolError } from '../error.ts'
import { blockingFindings, checkFigureRendering } from './render-check.ts'
import { SvgAnnotateError } from './svg-annotate.ts'

/** 门禁参数：交付文件、净距档位、是否阻断与报告归属。 */
type RenderCheckGateArgs = {
  /** 已写入的交付 SVG 路径。 */
  path: string
  /** 追加警告的去处（调用方的 warnings 数组）。 */
  warnings: string[]
  /** 图型净距（毫米）；0 表示只判穿字。 */
  clearanceMm: number
  /** 命中阻断级发现时是否抛错（Config.figureFailOnRenderFindings）。 */
  failOnFindings: boolean
  /** 错误归属的工具名（PatentToolError.details.tool）。 */
  tool: 'generate_patent_figure' | 'generate_structure_figure'
  /** 报告前缀（如「面板 B 」「图2 」），用于多面板/多视图时指明是哪一个。 */
  label?: string
}

/**
 * 复核一张已写入的 SVG。
 *
 * 读失败只记警告：文件刚由生成本身写入，读不回来时不该把已完成的生成判成失败。
 * 输入安全检查被拒时同样只记警告——写入路径已过同一检查，这里拒掉说明复核本身
 * 无法量测，而不是图面有缺陷。
 * @param args - 门禁参数。
 * @throws PatentToolError 已开启 strict 且存在除 `not-measured` 外的 finding 时。
 */
export async function gateRenderedSvg(args: RenderCheckGateArgs): Promise<void> {
  const where = args.label === undefined ? args.path : `${args.label}${args.path}`
  let svg: string
  try {
    svg = await readFile(args.path, 'utf8')
  } catch (error) {
    /* v8 ignore start -- the delivered file was just written; a read failure is reported without aborting */
    args.warnings.push(`渲染复核被跳过：读取 ${where} 失败（${error instanceof Error ? error.message : String(error)}）`)
    return
    /* v8 ignore stop */
  }

  let findings: readonly { readonly check: string; readonly message: string }[]
  try {
    const report = checkFigureRendering(svg, {
      maxBytes: Buffer.byteLength(svg, 'utf8'),
      // 显式传 0：省略该参数会退回复核的 1.5 默认值，等于关不掉净距。
      textClearanceMm: args.clearanceMm,
    })
    findings = blockingFindings(report)
    args.warnings.push(...report.findings.map(finding => `渲染复核：${finding.message}`))
  } catch (error) {
    /* v8 ignore start -- the rendered file already passed the same safety check during layout/write */
    if (!(error instanceof SvgAnnotateError)) throw error
    args.warnings.push(`渲染复核被跳过：${error.message}`)
    return
    /* v8 ignore stop */
  }

  if (!args.failOnFindings || findings.length === 0) return
  throw new PatentToolError(
    'tool_execution_failed',
    `渲染复核未通过（${String(findings.length)} 项）：\n`
    + findings.map(finding => `- ${finding.message}`).join('\n')
    + `\n文件已写入 ${where}，但未导出交付件；修正后重跑。`,
    { tool: args.tool },
  )
}
