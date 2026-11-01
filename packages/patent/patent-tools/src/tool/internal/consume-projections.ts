/**
 * `consumes` 的命名投影：把一个上游阶段的产出压成交给下游提示词的紧凑文本。
 *
 * 为什么需要投影：结构化原子（claim-chart、oa-parse）的阶段产出是
 * `JSON.stringify(value, null, 2)` 的**格式化 JSON**——要素映射表 8 行就有四千多字，
 * 其中大半是 `"quote": ""`、`"verified": false` 这类下游一个字都不用的字段。链式阶段
 * 拿到全文，既挤占提示词，又要模型自己从 JSON 里挑结论。
 *
 * 投影只做**信息整形**，不做校验：取不到期望结构时按原文交出并注明原因。判读者是
 * 下游模型，不是这里；在这里抛错只会把「上游多输出一个字段」升级成运行失败。
 *
 * 投影键的形态是 `<阶段 id>#<投影名>`，注册表键与 manifest 里 `consumes` 的条目
 * 字节一致——校验与取值必须能对上同一个字符串，否则「校验通过、运行时找不到」。
 */

import type { PipelineState } from '@deepseek-ai/dsh-patent-core'
import { WorkflowError, getStateString, parseConsumeRef } from '@deepseek-ai/dsh-patent-core'

/**
 * 一个投影：把上游阶段产出原文压成提示词文本。
 * `state` 一并给出，是因为摘要可能已经由该阶段自己产出（oa-parse 就写
 * `office_action_summary`），重算既浪费也可能与阶段产出不一致。
 */
type ConsumeProjector = (text: string, state: PipelineState) => string

/** 要素原文在投影表里的截断长度：够认出特征，又不把整句权利要求搬两遍。 */
const ELEMENT_TEXT_LIMIT = 40

/** 投影注册表：键为 `'<阶段 id>#<投影名>'`，与 manifest 的 `consumes` 条目同形。 */
export const CONSUME_PROJECTORS: Readonly<Record<string, ConsumeProjector>> = {
  'claim-chart#rows': projectChartRows,
  'parse#oa-summary': projectParseSummary,
}

/** 已注册的投影键集合，供 `validateWorkflowManifest` 在 manifest 层 fail-loud。 */
export const CONSUME_PROJECTION_KEYS: ReadonlySet<string> = new Set(Object.keys(CONSUME_PROJECTORS))

/**
 * 按 `consumes` 条目取出该阶段应交给提示词的文本。
 * @param entry - `'stage'` 或 `'stage#projection'` 形态的条目。
 * @param text - 该阶段的产出原文。
 * @param state - 累积运行状态（投影可能读同阶段的兄弟键）。
 * @returns 投影后的文本；条目不带投影时即原文。
 * @throws WorkflowError 条目带投影但该投影未注册——静默退化为全文会让提示词悄悄涨回去。
 */
export function projectConsumedOutput(entry: string, text: string, state: PipelineState): string {
  const { projection } = parseConsumeRef(entry)
  if (projection === undefined) return text
  const projector = CONSUME_PROJECTORS[entry]
  if (projector === undefined) {
    throw new WorkflowError(`consumes 引用了未注册的投影: ${entry}`)
  }
  return projector(text, state)
}

/** 宽松读取：阶段产出是外部文本，任何字段都可能缺失或类型不对。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 宽松读取数组字段。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** 宽松读取字符串字段。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 单元格文本：竖线与换行会截断表格行，先抹平再截断。 */
function cell(text: string, limit = ELEMENT_TEXT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').replaceAll('|', '／').trim()
  if (flat.length === 0) return '—'
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * `claim-chart#rows`：要素映射结论行。
 *
 * 给下游的是「哪个要素在哪个对比文件上是什么结论、能不能引到某段」，而不是整张
 * 对照表：逐行全文引用留在 run 记录里，正文需要回指时按要素编号写「见对照表 F2」。
 * @param text - claim-chart 阶段产出（格式化 JSON）。
 * @returns 结论表 + 按结论分组的缺口行；无法解析时按原文交出并注明。
 */
function projectChartRows(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return `（claim-chart 产出不是可解析的对照表 JSON，以下为原文）\n${text}`
  }
  const chart = asRecord(parsed)
  if (chart === undefined) return `（claim-chart 产出不是对照表对象，以下为原文）\n${text}`
  const elements = asArray(chart.elements)
  const targets = asArray(chart.targets)
  const rows = asArray(chart.rows)
  if (elements.length === 0 && rows.length === 0) {
    return '（claim-chart 未产出任何要素或映射行）'
  }
  /** 要素 id → 权利要求号与原文，按 id 索引（行里只有 id）。 */
  const elementById = new Map<string, { claimNo: string; text: string }>()
  for (const item of elements) {
    const element = asRecord(item)
    if (element === undefined) continue
    const id = asText(element.id)
    const claimNo = element.claimNo
    elementById.set(id, {
      claimNo: typeof claimNo === 'number' ? String(claimNo) : asText(claimNo),
      text: asText(element.text),
    })
  }
  const lines = [
    `要素映射结论（${String(elements.length)} 项要素 / ${String(targets.length)} 篇对比文件；`
    + '逐行全文引用与 pin-cite 留在对照表，此处只给结论行）',
    '| 要素 | 权项 | 要素原文 | 对比文件 | 结论 | pin-cite |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of rows) {
    const row = asRecord(item)
    if (row === undefined) continue
    const elementId = asText(row.elementId)
    const element = elementById.get(elementId)
    lines.push(
      `| ${cell(elementId, 12)} | ${cell(element?.claimNo ?? '', 6)} | ${cell(element?.text ?? '')} `
      + `| ${cell(asText(row.targetId), 24)} | ${cell(asText(row.mapping), 32)} `
      + `| ${cell(asText(row.pinCite), 32)} |`,
    )
  }
  if (rows.length === 0) lines.push('| — | — | （图表未产出映射行） | — | — | — |')
  const gaps = groupGaps(asArray(chart.gaps))
  if (gaps.length > 0) lines.push(`缺口（第一优先，按结论分组）：${gaps}`)
  if (targets.length === 0) lines.push('（未声明对比文件目标：本表无映射对象，答复中不得据此认定已公开）')
  return lines.join('\n')
}

/**
 * 缺口按结论分组：`needs-evidence 3 项（1a、1b、1c）`。
 *
 * 不逐条展开 reason/suggestion —— 同一结论的缺口建议动作是同一句，逐条列会把
 * 8 行缺口写成 8 句重复的话，正是本阶段要消掉的复述。
 * @param gaps - 图表自带的 gap 列表。
 * @returns 一句分组说明；无缺口时为空串。
 */
function groupGaps(gaps: readonly unknown[]): string {
  const byKind = new Map<string, string[]>()
  for (const item of gaps) {
    const gap = asRecord(item)
    if (gap === undefined) continue
    const kind = asText(gap.kind)
    if (kind.length === 0) continue
    const ids = byKind.get(kind) ?? []
    ids.push(asText(gap.elementId))
    byKind.set(kind, ids)
  }
  return [...byKind.entries()]
    .map(([kind, ids]) => `${kind} ${String(ids.length)} 项（${ids.join('、')}）`)
    .join('；')
}

/**
 * `parse#oa-summary`：优先用 oa-parse 阶段自己写出的中文摘要。
 *
 * 摘要（`office_action_summary`）与结构化结果由同一阶段一起产出，重算一遍只是把
 * 同一段文字写第二遍，还会与阶段产出分叉。摘要缺席（重放调用方自己给各阶段产出的
 * 路径不跑原子）时退回原文并注明，下游至少知道拿到的是解析结果本身。
 * @param text - `parse` 阶段产出（`oa-parse` 的结构化 JSON）。
 * @param state - 累积运行状态（摘要键在这里）。
 * @returns 中文摘要；摘要缺席时为原文加说明。
 */
function projectParseSummary(text: string, state: PipelineState): string {
  const summary = getStateString(state, 'office_action_summary').trim()
  if (summary.length > 0) return summary
  return `（该阶段未产出中文摘要，以下为解析结果原文）\n${text}`
}
