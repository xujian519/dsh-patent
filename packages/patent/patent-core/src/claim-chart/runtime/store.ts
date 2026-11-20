/**
 * claim-chart 持久化（对齐 worker 体系惯例：data/cases/<caseId>/outputs/）：
 * claim-chart-<chartId>.json（结构化，供下游 novelty/inventiveness/draft 消费）
 * + claim-chart-<chartId>.md（交付物：顶部 gap list + 免责声明 + 逐要素映射表）。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, assertSafeId } from '../../persist-utils.ts'
import { caseOutputsDir } from '../../paths.ts'
import { assertPathSegment } from '../../safe-path.ts'
import type { ClaimChart, GapKind } from '../protocol/types.ts'

/**
 * 计算 chart 文件路径基名（防御路径注入：chartId 仅允许安全字符集）。
 * @param caseId - 案例 id。
 * @param chartId - chart id。
 * @returns 不含扩展名的文件路径基名。
 */
export function chartFileBase(caseId: string, chartId: string): string {
  // 防御路径注入：caseId 与 chartId 都直接拼入路径，必须各自校验。
  assertPathSegment(caseId, 'caseId', message => new RangeError(message))
  assertSafeId(chartId, 'chartId')
  return join(caseOutputsDir(caseId), `claim-chart-${chartId}`)
}

/**
 * 持久化 claim chart（原子写 JSON + Markdown 交付物）。
 * @param chart - 待保存的 ClaimChart。
 * @param caseId - 案例 id。
 * @returns 写入的 JSON 与 Markdown 文件路径。
 */
export async function saveClaimChart(chart: ClaimChart, caseId: string): Promise<{ jsonPath: string; mdPath: string }> {
  const base = chartFileBase(caseId, chart.chartId)
  mkdirSync(caseOutputsDir(caseId), { recursive: true })
  const jsonPath = `${base}.json`
  const mdPath = `${base}.md`
  // 原子写（tmp+rename）：并发/中断不产生半写 JSON（对齐 workflow-store / flexible-plan-store）。
  await atomicWriteJson(jsonPath, JSON.stringify(chart, null, 2))
  await atomicWriteJson(mdPath, renderChartMarkdown(chart))
  return { jsonPath, mdPath }
}

/**
 * 从磁盘加载 claim chart（损坏/人工编辑文件返回 null）。
 * @param caseId - 案例 id。
 * @param chartId - chart id。
 * @returns 加载的 ClaimChart，文件缺失或损坏时返回 null。
 */
export function loadClaimChart(caseId: string, chartId: string): ClaimChart | null {
  const p = `${chartFileBase(caseId, chartId)}.json`
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ClaimChart>
    // 最小形状守卫：损坏/人工编辑文件不崩溃（chart.ts 的 verified 合并依赖 rows 数组）。
    if (!Array.isArray(parsed.rows) || !Array.isArray(parsed.elements)) return null
    // 引用关系是后加的字段：旧文件没有它，按"引用关系未知"处理（不得据此断言全部权项独立）。
    if (!Array.isArray(parsed.claims)) parsed.claims = []
    // 旧文件用 gaps[].mapping 表示缺口类别；kind 是后加字段，先迁移再交给渲染。
    if (!Array.isArray(parsed.gaps)) parsed.gaps = []
    for (const gap of parsed.gaps as { kind?: GapKind; mapping?: GapKind }[]) {
      if (gap.kind === undefined && gap.mapping !== undefined) gap.kind = gap.mapping
    }
    return parsed as ClaimChart
  } catch {
    return null
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * 渲染 claim chart 的 Markdown 交付物（gap list + 免责声明 + 逐要素映射表）。
 * @param chart - 待渲染的 ClaimChart。
 * @returns Markdown 文本。
 */
export function renderChartMarkdown(chart: ClaimChart): string {
  const byId = new Map(chart.elements.map(el => [el.id, el]))
  const lines: string[] = []
  lines.push(`# 权利要求对照表（Claim Chart）— ${chart.mode}`, '')
  lines.push(`> ${chart.draftNotice}`, '')
  lines.push('## Gap List（优先处理）', '')
  if (chart.gaps.length === 0) {
    lines.push('（无缺口：全部要素均有证据映射）', '')
  } else {
    for (const g of chart.gaps) {
      const el = byId.get(g.elementId)
      lines.push(`- [ ] \`${g.elementId}\` ${el?.text ?? ''} → ${g.targetId}（${g.kind}）：${g.suggestion}`)
    }
    lines.push('')
  }
  lines.push('## 逐要素映射表', '')
  lines.push('| # | Element | 目标特征/证据 | Evidence (pin-cite) | Mapping | Verified |', '|---|---|---|---|---|---|')
  for (const r of chart.rows) {
    const el = byId.get(r.elementId)
    lines.push(
      `| ${r.elementId} | ${escapeCell(el?.text ?? '')} | ${escapeCell(r.quote)} | ${escapeCell(r.pinCite)} | ${r.mapping} | ${r.verified ? '✓' : '☐'} |`,
    )
  }
  if (chart.claims.length > 0) {
    lines.push('', '## 权利要求引用关系', '')
    lines.push('| 权利要求 | 类型 | 引用 |', '|---|---|---|')
    for (const claim of chart.claims) {
      lines.push(
        `| ${claim.claimNo} | ${claim.claimType === 'dependent' ? '从属' : '独立'} | ${claim.refersTo.join('、') || '—'} |`,
      )
    }
  }
  return lines.join('\n')
}
