/**
 * Rule-lock atom：法条规则锁定与有效性判定。
 *
 * 为 workflow 提供"规则锁定"能力：给定一组法条引用，逐条判定其四态有效性
 * （active/revised/repealed/unverified），输出结构化锁定报告。原子是确定性的，
 * 不调用模型——所有判定来自随包法条索引（`patent-law` baseline）。
 *
 * 权威源决策：优先使用 `patent-law` baseline（确定性、可离线、已转录验证）。
 * 当 baseline 中找不到对应法条时，标记为 `unverified`（fail-closed）。
 *
 * 输入约定：
 * - `rule_lock_provisions`：法条引用列表（string[]），如
 *   `["专利法第22条第3款", "实施细则第20条"]`。
 * - `rule_lock_as_of`：可选判定时间点（YYYY-MM-DD 字符串）。
 *
 * 输出约定：
 * - `rule_lock_report`：面向人工复核的中文报告（主输出）。
 * - `rule_lock_locked`：结构化锁定结果数组。
 * - `rule_lock_unverified`：无法判定的法条列表。
 * @module @deepseek-ai/dsh-patent-law/rule-lock
 */

import type { Atom, AtomCategory } from '@deepseek-ai/dsh-patent-core'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateString,
} from '@deepseek-ai/dsh-patent-core'
import { queryValidity } from './citator.ts'
import type { LawBaseline, LawLineageSnapshot, LawName, ValidityResult, ValidityState } from './types.ts'

/** 法条粒度级别。 */
export type RuleLockLevel = 'article' | 'section' | 'clause'

/** 单条法条的锁定结果。 */
export type RuleLockEntry = {
  /** 法条引用原文。 */
  provision: string
  /** 粒度级别：条（article）、款（section）、项（clause）。 */
  level: RuleLockLevel
  /** 生效日期（YYYY-MM-DD），无法确定时为 null。 */
  effectiveDate: string | null
  /** 是否已失效（revised 或 repealed 时为 true）。 */
  stale: boolean
  /** 四态有效性判定。 */
  validityStatus: ValidityState
}

/** rule-lock 原子的结构化输出。 */
export type RuleLockOutput = {
  /** 已完成锁定的法条结果。 */
  locked: RuleLockEntry[]
  /** 无法判定的法条原文列表。 */
  unverified: string[]
}

/** rule-lock 原子：法条规则锁定与有效性判定。 */
export const ruleLockAtom: Atom = {
  name: 'rule-lock',
  description: '法条规则锁定：逐条判定四态有效性（active/revised/repealed/unverified），输出结构化锁定报告（纯函数，不调用模型）',
  category: 'gate',
  inputSchema: ['rule_lock_provisions', 'rule_lock_as_of'],
  outputSchema: ['rule_lock_report', 'rule_lock_locked', 'rule_lock_unverified'],
}

/** 法条引用列表的默认状态键。 */
export const DEFAULT_RULE_LOCK_PROVISIONS_KEY = 'rule_lock_provisions'

/** 判定时间点的默认状态键。 */
export const DEFAULT_RULE_LOCK_AS_OF_KEY = 'rule_lock_as_of'

/**
 * 从 ValidityResult 推断粒度级别。
 * @param result - citator 返回的有效性结果。
 * @returns 粒度级别。
 */
function inferLevel(result: ValidityResult): RuleLockLevel {
  if (result.reference.kind === 'guideline-section') return 'section'
  if (result.reference.item !== undefined) return 'clause'
  if (result.reference.paragraph !== undefined) return 'section'
  return 'article'
}

/**
 * 从 ValidityResult 提取生效日期。
 *
 * 有沿革记录时取最近一次修订的生效日期——这是条文本身的生效时间；
 * 否则回退到索引条目的 `verifiedOn`（转录核验日期，不是法律生效日期）；
 * 均不可用时返回 null。
 * @param result - citator 返回的有效性结果。
 * @returns 生效日期字符串或 null。
 */
function extractEffectiveDate(result: ValidityResult): string | null {
  if (result.revisionHistory !== undefined && result.revisionHistory.length > 0) {
    const last = result.revisionHistory[result.revisionHistory.length - 1] as { effectiveDate: string }
    return last.effectiveDate
  }
  if (result.entry !== undefined && result.entry.verifiedOn !== null) return result.entry.verifiedOn
  return null
}

/**
 * 对单条法条引用执行锁定判定。
 * @param provision - 法条引用原文。
 * @param baselines - 法条索引。
 * @param asOf - 可选判定时间点。
 * @param lineage - 可选法条沿革快照。
 * @returns 锁定结果条目。
 */
function lockOneProvision(
  provision: string,
  baselines: Map<LawName, LawBaseline>,
  asOf: string | undefined,
  lineage: LawLineageSnapshot | undefined,
): RuleLockEntry {
  const query = asOf !== undefined ? { provision, asOf } : { provision }
  const result = queryValidity(query, baselines, lineage)
  return {
    provision,
    level: inferLevel(result),
    effectiveDate: extractEffectiveDate(result),
    stale: result.state === 'revised' || result.state === 'repealed',
    validityStatus: result.state,
  }
}

/**
 * 批量锁定法条并收集 unverified 列表。
 * @param provisions - 法条引用原文列表。
 * @param baselines - 法条索引。
 * @param asOf - 可选判定时间点。
 * @param lineage - 可选法条沿革快照；给出时四态判定以沿革记录为准。
 * @returns 结构化锁定输出。
 */
export function lockProvisions(
  provisions: string[],
  baselines: Map<LawName, LawBaseline>,
  asOf?: string,
  lineage?: LawLineageSnapshot,
): RuleLockOutput {
  const locked: RuleLockEntry[] = []
  const unverified: string[] = []
  for (const provision of provisions) {
    const entry = lockOneProvision(provision, baselines, asOf, lineage)
    if (entry.validityStatus === 'unverified') {
      unverified.push(provision)
    }
    locked.push(entry)
  }
  return { locked, unverified }
}

/**
 * 渲染法条锁定报告。
 * @param output - 结构化锁定输出。
 * @returns 面向人工复核的中文报告。
 */
export function renderRuleLockReport(output: RuleLockOutput): string {
  const { locked, unverified } = output
  if (locked.length === 0) {
    return '法条规则锁定：未提供法条引用列表。'
  }
  const activeCount = locked.filter(e => e.validityStatus === 'active').length
  const revisedCount = locked.filter(e => e.validityStatus === 'revised').length
  const repealedCount = locked.filter(e => e.validityStatus === 'repealed').length
  const unverifiedCount = unverified.length

  const lines = [
    `法条规则锁定：共 ${locked.length} 条（现行有效 ${activeCount}，已修订 ${revisedCount}，已废止 ${repealedCount}，未判定 ${unverifiedCount}）`,
  ]

  for (const entry of locked) {
    const statusLabel = validityLabel(entry.validityStatus)
    const staleFlag = entry.stale ? '⚠️已失效' : '✓'
    const dateText = entry.effectiveDate !== null ? `（生效：${entry.effectiveDate}）` : ''
    lines.push(`- ${entry.provision}：${statusLabel} ${staleFlag}${dateText}`)
  }

  if (unverified.length > 0) {
    lines.push('')
    lines.push(`未判定法条（${unverified.length} 条）：${unverified.join('、')}`)
    lines.push('说明：以上法条在随包索引中未找到对应条目或款号，有效性无法判定。')
  }

  lines.push('')
  lines.push('限制说明：本原子只依据随包法条索引做四态判定；索引未收录的法律版本或条文变更不在判定范围内。')
  return lines.join('\n')
}

/**
 * 四态有效性对应的中文标签。
 * @param state - 有效性状态。
 * @returns 中文标签。
 */
function validityLabel(state: ValidityState): string {
  switch (state) {
    case 'active':
      return '现行有效'
    case 'revised':
      return '已修订'
    case 'repealed':
      return '已废止'
    case 'unverified':
      return '未判定'
  }
}

/**
 * 从 JSON 字符串解析法条引用列表；非法 JSON 或非数组时返回 null。
 * @param raw - JSON 字符串。
 * @returns 解析后的数组或 null。
 */
function readJsonProvisions(raw: string): unknown[] | null {
  if (raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** rule-lock 执行器：逐条判定法条有效性并输出锁定报告。 */
export class RuleLockHandler implements StageHandler {
  readonly name = 'rule-lock'
  readonly category = 'gate' as AtomCategory

  /** 法条索引，由构造器注入。 */
  private readonly baselines: Map<LawName, LawBaseline>
  /** 法条沿革快照；缺席时只按索引判定。 */
  private readonly lineage: LawLineageSnapshot | undefined

  /**
   * @param baselines - 法条索引，由构造器注入。
   * @param lineage - 可选法条沿革快照；给出时四态判定以沿革记录为准。
   */
  constructor(baselines: Map<LawName, LawBaseline>, lineage?: LawLineageSnapshot) {
    this.baselines = baselines
    this.lineage = lineage
  }

  /**
   * 逐条判定法条有效性。
   * @param input - 阶段执行输入（state 携带法条列表与可选时间点）。
   * @returns 报告、结构化锁定结果与未判定列表。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const state = input.state
    const rawValue = state[DEFAULT_RULE_LOCK_PROVISIONS_KEY]
    const rawProvisions: unknown[] | null = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === 'string'
        ? readJsonProvisions(rawValue)
        : []

    if (rawProvisions === null) {
      return {
        rule_lock_report: '法条规则锁定：state.rule_lock_provisions 不可读（不是合法 JSON 数组）。',
        rule_lock_locked: [],
        rule_lock_unverified: [],
      }
    }

    if (rawProvisions.length === 0) {
      return {
        rule_lock_report: '法条规则锁定：未提供法条引用列表（state.rule_lock_provisions 为空）。',
        rule_lock_locked: [],
        rule_lock_unverified: [],
      }
    }

    const provisions: string[] = []
    for (const item of rawProvisions) {
      if (typeof item === 'string' && item.trim().length > 0) {
        provisions.push(item.trim())
      }
    }

    if (provisions.length === 0) {
      return {
        rule_lock_report: '法条规则锁定：提供的法条引用列表为空（无有效字符串元素）。',
        rule_lock_locked: [],
        rule_lock_unverified: [],
      }
    }

    const asOfRaw = getStateString(state, DEFAULT_RULE_LOCK_AS_OF_KEY)
    const asOf = asOfRaw.trim().length > 0 ? asOfRaw.trim() : undefined

    const output = lockProvisions(provisions, this.baselines, asOf, this.lineage)
    return {
      rule_lock_report: renderRuleLockReport(output),
      rule_lock_locked: output.locked,
      rule_lock_unverified: output.unverified,
    }
  }
}
