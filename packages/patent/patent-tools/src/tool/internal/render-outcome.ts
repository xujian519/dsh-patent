/**
 * 附图渲染失败的统一映射：把渲染与导出步骤的失败结果按同一张表翻成专利工具错误。
 *
 * 外部步骤的结果同形（`generate_patent_figure` 的 Graphviz/矢量绘制、它的文字转路径、
 * `generate_structure_figure` 的 FreeCAD 投影与文字转路径），失败语义也必须是同一条：
 * `not_installed` 是环境缺失（可修复的前置条件），`aborted` 是调用方取消，其余归
 * `tool_execution_failed`。每处各自维护的映射会先在这张表上漂移，再让同一类失败在
 * 不同工具里报出不同错误码。剖视图的 `sections.source` 展开有额外的两个码（输入非法、
 * 模型文件缺失），一并收在这里（见 {@link sectionSourceError}）。
 *
 * `src/figure/` 只做渲染与失败归因（`describeRenderFailure` 返回原因短语），
 * 工具协议面（错误码与 `tool` 元数据）留在工具层，因此本模块位于 `tool/internal/`。
 *
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/render-outcome
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import { PatentToolError } from '../../error.ts'
import type { SectionSourceError } from '../../figure/section-source.ts'

/** 附图工具名（`generate_patent_figure` 兼管 Graphviz 与直绘两条通路及其文字转路径）。 */
type FigureToolName = 'generate_patent_figure' | 'generate_structure_figure'

/** 两类渲染结果共有的判定形态：成功，或按码分类的失败。 */
type RenderOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'not_installed' | 'render_failed' | 'aborted'; readonly error: string }

/**
 * 渲染失败统一映射：not_installed→setup_required / aborted→tool_aborted / 其余→tool_execution_failed。
 * @param outcome - 渲染结果；成功时直接返回。
 * @param tool - 抛出错误携带的工具名。
 * @returns 无；成功时把 `outcome` 收窄为成功分支。
 */
export function assertRendered<T extends RenderOutcome>(
  outcome: T,
  tool: FigureToolName,
): asserts outcome is Extract<T, { ok: true }> {
  if (outcome.ok) return
  if (outcome.code === 'not_installed') {
    throw new PatentToolError('setup_required', outcome.error, { tool })
  }
  if (outcome.code === 'aborted') {
    throw new PatentToolError('tool_aborted', `${tool} aborted`, { tool })
  }
  throw new PatentToolError('tool_execution_failed', outcome.error, { tool })
}

/**
 * 剖切来源失败的统一映射（与 {@link assertRendered} 同一张表的扩展）：输入非法→
 * `invalid_tool_input`、模型文件缺失→`file_not_found`、环境缺失→`setup_required`、
 * 调用方取消→`tool_aborted`，其余实现失败（剖切几何、剖面线）→`tool_execution_failed`。
 * @param error - `sections.source` 展开时抛出的错误。
 * @param tool - 抛出错误携带的工具名。
 * @returns 对应的专利工具错误。
 */
export function sectionSourceError(error: SectionSourceError, tool: FigureToolName): PatentToolError {
  switch (error.code) {
    case 'invalid_input':
      return new PatentToolError('invalid_tool_input', error.message, { tool })
    case 'file_not_found':
      return new PatentToolError('file_not_found', error.message, { tool })
    case 'not_installed':
      return new PatentToolError('setup_required', error.message, { tool })
    case 'aborted':
      return new PatentToolError('tool_aborted', error.message, { tool })
    case 'geometry_failed':
    case 'hatch_failed':
      return new PatentToolError('tool_execution_failed', error.message, { tool })
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new source error code here */
    default:
      return assertNever(error.code, 'section source error code')
  }
}
