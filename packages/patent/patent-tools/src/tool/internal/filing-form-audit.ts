/**
 * 申请文件成文前的形式预检。
 *
 * `build_patent_filing` 只做草案结构校验（`validateSpecDraft`），不跑形式规则；
 * 交付门禁里的 `validate_specification` 又只按会话记账，无法证明模型交给它的
 * 文本就是这次要成文的草案。正式稿的形式错误（附图标记括号、图号空格、摘要
 * 篇幅、禁止性表述、发明名称）因此可能整批漏出。
 *
 * 本模块用 docx 通道同一份 `contentFromDraft` 映射重建说明书全文，再跑
 * `validateSpecification` 的确定性规则。校验的文本与成文的文本出自同一次映射，
 * 所以两者的标题、项号与图号必然同源。章节标题由映射按 `SPEC_PART_ORDER` 生成，
 * 集合与顺序不可能错；`structure` 族里能命中的只剩与草案内容有关的项
 * （实用新型缺附图、声明无附图却引用图号）。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/filing-form-audit
 */

import { filingTextsFromDraft } from '@deepseek-ai/dsh-patent-filing'
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
 * 形式规则按行扫描标题与图号，因此各部分标题必须写成标题行。投影由
 * {@link filingTextsFromDraft} 生成（h3 标题 + p 正文；`table` 节点不带文字，
 * 行内容不进文本，形式规则也不看表格内容，表题段照常进入），与交付门禁的
 * digest 核对消费同一份摊平结果。
 * @param draft - 已通过 `validateSpecDraft` 的草案。
 * @returns 说明书全文、权利要求全文与摘要全文。
 */
export function formTextFromDraft(draft: SpecDraft): { text: string; claims: string; abstract: string } {
  const { text, claims, abstract } = filingTextsFromDraft(draft)
  return { text, claims, abstract }
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
 *
 * 行号指向本模块重建的全文，模型手上没有这份文本，指不到自己该改的那句；
 * 因此给出规则命中的原句。
 * @param violations - 形式规则报出的 error 级违规。
 * @returns 逐条列出规则、命中句与修法的多行文本。
 */
export function renderFilingFormDenial(violations: readonly SpecViolation[]): string {
  const lines = [
    `申请文件形式预检未通过，成文已拒绝（${violations.length} 项）：`,
  ]
  for (const violation of violations) {
    lines.push(`- ${violation.rule}：${violation.message}`)
    if (violation.matchedSentence !== undefined) lines.push(`  命中句：${violation.matchedSentence}`)
    if (violation.suggestion !== undefined) lines.push(`  修法：${violation.suggestion}`)
  }
  lines.push('修改 draft 后重新调用；被拒绝的调用不会写出 docx。')
  return lines.join('\n')
}
