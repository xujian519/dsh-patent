/**
 * 断言安全的修订提示构造器（移植自 Sati 的 src/patent/retry-hints.ts，对齐 Ouroboros
 * 的 retry_hints 语义）。
 *
 * 背景：把"判分断言"（通过线 35、总分、五维分数等数字）从 worker/原子可见面剥离后，
 * 失败重试不能退回"公开答案"（把最低分维度告诉 worker 等于邀请它优化指标而非改善产出）。
 * 本构造器只产出**证据型**提示：命中套话短语的原文与建议替换、结构性问题行级定位——
 * 即"这一轮评审者实际看到了什么"，而非"要怎么凑分"。
 *
 * 保密契约（防回归测试锁定，勿破坏）：
 * - 绝不输出 score 的任一维度数值（directness/evidence/rhythm/practicality/concision）、
 *   total、通过线或"xx 分"；
 * - 绝不输出 checklist 项的得分判定；
 * - 只输出 changes（原词→建议替换）与 issues（行号+原文+建议）两类证据。
 * @module @deepseek-ai/dsh-patent-tools/internal/retry-hints
 */

import type { SlopAnalysis } from '@deepseek-ai/dsh-patent-core'

/** 每条 hint 证据清单的条目上限（防提示过长挤占上下文）。 */
const MAX_CHANGES = 8
const MAX_ISSUES = 3

/**
 * 反套话评审的断言安全修订提示。
 *
 * 输入 slop 分析（SlopGateHandler 已计算的确定性结果），输出可注入重跑
 * prompt 的"上一轮评审意见"证据文本；无任何可引证据时返回 undefined
 * （调用方不注入，避免空提示语义噪音）。
 * @param analysis - slop 引擎对草稿文本的确定性分析。
 * @returns 证据型修订提示文本；无证据时 undefined。
 */
export function buildSlopRevisionHint(analysis: SlopAnalysis): string | undefined {
  const lines: string[] = []
  const changes = analysis.changes.slice(0, MAX_CHANGES)
  const issues = analysis.issues.slice(0, MAX_ISSUES)
  const residual = analysis.changes.length + analysis.issues.length - (changes.length + issues.length)

  if (changes.length > 0) {
    lines.push('- 命中套话表述（类别 → 建议替换）：')
    for (const change of changes) {
      const replacement = change.replacement.trim()
      lines.push(
        replacement !== '（删除）'
          ? `  · "${change.original.trim()}" → "${replacement}"`
          : `  · "${change.original.trim()}"（建议删除或改写为具体陈述）`,
      )
    }
  }
  if (issues.length > 0) {
    lines.push('- 结构性问题（行号定位）：')
    for (const issue of issues) {
      const suggestion = issue.suggestion.trim()
      lines.push(
        suggestion.length > 0
          ? `  · L${issue.line} 行：\`${issue.text.trim()}\`（${suggestion}）`
          : `  · L${issue.line} 行：\`${issue.text.trim()}\``,
      )
    }
  }
  if (residual > 0) {
    lines.push(`- 另有 ${residual} 处同类问题，请按同一方向整体修订。`)
  }
  if (lines.length === 0) return undefined
  lines.push('- 修订方向：用具体数据、动作或事实陈述替代模糊表述，使内容可核实。')
  return lines.join('\n')
}
