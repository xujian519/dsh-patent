/**
 * 申请文件成文前的形式预检。
 *
 * `build_patent_filing` 只做草案结构校验（`validateSpecDraft`），不跑形式规则；
 * 交付门禁里的 `validate_specification` 又只按会话记账，无法证明模型交给它的
 * 文本就是这次要成文的草案。正式稿的形式错误（章节标题集合与顺序、附图标记
 * 括号、图号空格、摘要篇幅）因此可能整批漏出。
 *
 * 本模块用 docx 通道同一份 `contentFromDraft` 映射重建说明书全文，再跑
 * `validateSpecification` 的确定性规则。校验的文本与成文的文本出自同一次映射，
 * 所以两者的标题、项号与图号必然同源。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/filing-form-audit
 */

import { contentFromDraft } from '@deepseek-ai/dsh-patent-filing'
import type { SpecDraft } from '@deepseek-ai/dsh-patent-core'
import { validateSpecification } from '../validate-specification.ts'
import type { SpecFamily, SpecViolation } from '../spec-types.ts'

/**
 * 阻断成文的规则族：章节结构、附图形式、摘要、禁止性条款与发明名称。
 *
 * `description` 与 `claims` 族是实质撰写判断（实施例存在性、数值范围端点、
 * 特征覆盖），一份没写「实施例」字样的合法说明书也会命中；它们属于审查意见
 * 阶段的质量项，不构成形式退案理由，交给 `validate_specification` 的完整报告。
 */
const FORM_FAMILIES: ReadonlySet<SpecFamily> = new Set(['structure', 'figures', 'abstract', 'prohibitions', 'title'])

/**
 * 说明书正文按 docx 通道的节点顺序摊平为带 Markdown 标题的全文。
 *
 * 形式规则按行扫描标题与图号，因此五个部分标题必须写成标题行；表格不进正文文本，
 * 其内容由 `validateSpecification` 的表格类规则另行处理。
 * @param draft - 已通过 `validateSpecDraft` 的草案。
 * @returns 说明书全文、权利要求全文与摘要全文。
 */
export function formTextFromDraft(draft: SpecDraft): { text: string; claims: string; abstract: string } {
  const content = contentFromDraft(draft)
  const lines: string[] = []
  for (const node of content.specification) {
    if (node.kind === 'h3' || node.kind === 'h4') {
      lines.push(`### ${node.text ?? ''}`)
    } else if (node.kind === 'p') {
      lines.push(node.text ?? '')
    }
  }
  return {
    text: lines.join('\n\n'),
    claims: content.claims.join('\n'),
    abstract: content.abstract.join('\n'),
  }
}

/**
 * 对一份草案跑形式规则，只返回阻断成文的违规。
 *
 * warning 不阻断成文：体例项中以本部署的模板为准的部分（段落编号）在模板里已经决定，
 * 而启发式告警（附图引用、有益效果对比）不足以拒绝一份申请文件。
 * @param draft - 已通过 `validateSpecDraft` 的草案。
 * @returns 阻断成文的 error 级形式违规；无违规时为空数组。
 */
export function auditFilingDraft(draft: SpecDraft): SpecViolation[] {
  const { text, claims, abstract } = formTextFromDraft(draft)
  const report = validateSpecification({
    text,
    title: draft.meta.title,
    claims,
    abstract,
    has_drawings: draft.figureFiles.length > 0,
    drawing_count: draft.figureFiles.length,
  })
  return report.violations.filter(
    violation => violation.severity === 'error' && FORM_FAMILIES.has(violation.family),
  )
}

/**
 * 把阻断项渲染成模型可据此修改草案的拒绝理由。
 * @param violations - 形式规则报出的 error 级违规。
 * @returns 逐条列出规则、位置与修法的多行文本。
 */
export function renderFilingFormDenial(violations: readonly SpecViolation[]): string {
  const lines = [
    `申请文件形式预检未通过，成文已拒绝（${violations.length} 项）：`,
  ]
  for (const violation of violations) {
    const where = violation.line === undefined ? '' : `（第 ${violation.line} 行）`
    lines.push(`- ${violation.rule}${where}：${violation.message}`)
    if (violation.suggestion !== undefined) lines.push(`  修法：${violation.suggestion}`)
  }
  lines.push('修改 draft 后重新调用；被拒绝的调用不会写出 docx。')
  return lines.join('\n')
}
