/**
 * 宪法规则引擎 — 加载器。
 *
 * 从 YAML 资产加载并校验规则集。兼容两种 rules 形态：
 *   1) 数组：rules: [{ id, name, ... }, ...]
 *   2) 映射：rules: { 内部名: { id, name, ... }, ... }（BCIP constitutional YAML 形态）
 * 单文件解析失败不阻塞目录加载（跳过并告警），保证一条坏规则不拖垮整个引擎。
 * @module @deepseek-ai/dsh-patent-rule/runtime/RuleLoader
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { asRecord } from '@deepseek-ai/dsh-value'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  ConstitutionalRule,
  KeywordBlocklistCheck,
  LoadedRuleSet,
  RuleAction,
  RuleCheck,
  RuleCheckType,
  RuleSeverity,
  RuleSet,
  RuleSetValidationIssue,
} from '@deepseek-ai/dsh-patent-core'

const SEVERITIES: readonly RuleSeverity[] = ['critical', 'major', 'minor']
const ACTIONS: readonly RuleAction[] = ['block', 'warn', 'review', 'log']
const CHECK_TYPES: readonly RuleCheckType[] = [
  'keyword_blocklist',
  'pattern_analysis',
  'structural_analysis',
  'citation_analysis',
  'synonym_match',
  'quote_repetition',
  'empty_section',
  'sentence_repetition',
  'notice_ground_coverage',
  'unraised_statute_citation',
]

/**
 * 类型守卫：值是否为合法 RuleAction（与 ACTIONS 单一事实源一致）。
 * @param value - 待判断的值。
 * @returns 值是否为合法 RuleAction。
 */
export function isRuleAction(value: unknown): value is RuleAction {
  return typeof value === 'string' && ACTIONS.includes(value as RuleAction)
}

/**
 * 把任意值规整为纯对象（yaml Document.toJS 产物），非对象返回 null。
 * @param value - 待规整的值。
 * @returns 纯对象，非对象为 null。
 */
export { asRecord }

/**
 * 把任意值规整为字符串数组，含非字符串项或非数组时返回 null。
 * @param value - 待规整的值。
 * @returns 字符串数组，不合法时为 null。
 */
export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

/**
 * 判定字符串数组是否含至少一个可生效的词：数组非空，且存在去除首尾空白后非空的元素。
 *
 * `asStringArray` 只保证元素是字符串。空串/纯空白元素在消费路径上都会被丢弃——
 * `hasNegationContext` 的 `word.length > 0` 守卫与 `checkKeywordEntry` 的
 * `filter(s => s.length > 0)`——所以整表皆此类元素时豁免不了任何命中，而作者以为
 * 放行词已经生效。带首尾空白但含实词的条目**不**在此列：两条路径都会让它参与匹配
 * （否定词表按字面 `endsWith`，关键词先 `trim` 再 `indexOf`），语义窄但会生效，故保留。
 * 判定不修改元素，存储保留作者写下的原值。
 * @param list - 待判定的字符串数组。
 * @returns 含至少一个非空元素时为 true。
 */
export function hasNonEmptyWord(list: readonly string[]): boolean {
  return list.length > 0 && list.some(word => word.trim().length > 0)
}

/**
 * 关键词条目 `a|b|c` 至少有一个非空白备选；`["|"]` / `["  "]` 都不会命中任何文本。
 * @param list - 待判定的关键词条目列表。
 * @returns 至少一个条目含非空白备选时为 true。
 */
export function hasUsableKeywordEntry(list: readonly string[]): boolean {
  return list.some(entry => entry.split('|').some(word => word.trim().length > 0))
}

/**
 * 校验正则列表（语法 + 灾难性回溯启发式），非法时收集问题并返回 false。
 * 供 pattern_analysis / structural_analysis / premise 共用，保证 ReDoS 防护一致。
 * @param patterns - 待校验的正则列表。
 * @param ruleId - 所属规则 id（问题定位）。
 * @param issues - 问题收集器。
 * @param label - 问题消息中的名词（如 "正则" / "适用前提正则"）。
 * @returns 全部合法时为 true。
 */
function validateRegexPatterns(
  patterns: string[],
  ruleId: string,
  issues: RuleSetValidationIssue[],
  label = '正则',
): boolean {
  for (const pattern of patterns) {
    switch (regexProblem(pattern)) {
      case null:
        continue
      case 'blank':
        issues.push({ ruleId, message: `rule ${ruleId}: ${label}为空串（匹配任意文本，判据恒成立），已忽略` })
        return false
      case 'syntax':
        issues.push({ ruleId, message: `rule ${ruleId}: 非法${label} "${pattern}"` })
        return false
      case 'redos':
        issues.push({
          ruleId,
          message: `rule ${ruleId}: ${label}疑似灾难性回溯（嵌套量词） "${pattern}"`,
        })
        return false
      /* v8 ignore next -- closed union; the switch covers every problem kind. */
      default:
        return false
    }
  }
  return true
}

/**
 * 单条正则的问题类型；合法（非空白、语法通过且无嵌套量词）返回 null。
 * 空白串单列为问题：`new RegExp("")` 匹配任意文本，做前提会让规则恒被执行、
 * 做 pattern 会让规则恒命中——两种都是静默失效。
 */
function regexProblem(pattern: string): 'blank' | 'syntax' | 'redos' | null {
  if (pattern.trim().length === 0) return 'blank'
  try {
    new RegExp(pattern, 'i')
  } catch {
    return 'syntax'
  }
  return hasNestedQuantifier(pattern) ? 'redos' : null
}

/**
 * 单条正则是否可安全评估（语法合法 + 无嵌套量词）。
 * 供补丁解析（patent-compliance 的 activation-overrides）复用资产解析的同一判据，
 * 保证两条入口的 ReDoS 防护一致。
 * @param pattern - 待校验的正则。
 * @returns 可安全评估时为 true。
 */
export function isSafeRegex(pattern: string): boolean {
  return regexProblem(pattern) === null
}

/**
 * 声明的适用前提是否可用：非空数组，且每条都是可安全评估的非空白正则。
 * 空数组会让 `premiseSatisfied` 恒为真（前提形同未声明），空白串匹配任意文本
 * （前提恒成立）——两种写法都让「写了前提」的评审结论悄悄失效，故与非法正则同判。
 * 补丁解析与词表校验共用此判据（资产解析走 `parsePremise`，问题消息更分型）。
 * @param premise - 待校验的前提（调用方负责筛掉非字符串项，见 asStringArray）。
 * @returns 可用时为 true。
 */
export function isUsablePremise(premise: readonly string[]): boolean {
  return premise.length > 0 && premise.every(isSafeRegex)
}

/** 解析规则级适用前提（premise）：非空字符串数组 + 逐条正则校验；非法返回 undefined 并收集问题。 */
function parsePremise(
  raw: unknown,
  ruleId: string,
  issues: RuleSetValidationIssue[],
): string[] | undefined {
  if (raw === undefined) return undefined
  const premise = asStringArray(raw)
  if (premise === null || premise.length === 0) {
    issues.push({ ruleId, message: `rule ${ruleId}: premise 必须是非空字符串数组，已忽略` })
    return undefined
  }
  if (!validateRegexPatterns(premise, ruleId, issues, '适用前提正则')) return undefined
  return premise
}

/**
 * 简易灾难性回溯检测：捕获组内已有量词、组后又跟量词（`(a+)+` / `(a*)*`），
 * 或量化组内的备选互相前缀（`(a|aa)+`）。规则 YAML 来自不可信来源时可致 ReDoS。
 * `(a|b)+` 与固定重复 `(a){2}` 不构成嵌套量词，保持可用。
 */
function hasNestedQuantifier(pattern: string): boolean {
  if (/\}[+*]/.test(pattern)) return true
  const quantifiedGroups = /\(([^()]*)\)[+*{]/g
  for (const match of pattern.matchAll(quantifiedGroups)) {
    /* v8 ignore next -- the capture group always participates. */
    const content = match[1] ?? ''
    const body = content.startsWith('?:') ? content.slice(2) : content
    const branches = body.split('|').map(branch => branch.trim()).filter(branch => branch.length > 0)
    if (branches.some(a => branches.some(b => a !== b && b.startsWith(a)))) return true
    // `(?:` / `(?=` 等分组前缀不含量词；只看组内实际的重复量词。
    if (/[+*]|\{\d+,?\d*\}/.test(content)) return true
  }
  return false
}

type SynonymRequirementRaw = {
  element: string
  description?: string
  keywords: string[]
}

type StructuralElementRaw = {
  element: string
  description?: string
  patterns: string[]
}


/** 解析置信度阈值：缺省 1；非数字、非有限、越界时告警并按 1 处理。 */
function parseMinConfidence(raw: unknown, ruleId: string, issues: RuleSetValidationIssue[]): number {
  const valid = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
  if (raw !== undefined && !valid) {
    issues.push({ ruleId, message: `rule ${ruleId}: minConfidence 必须是 0..1 的数字，已按 1 处理` })
  }
  return valid ? raw : 1
}

/** 解析单个 check 对象；非法返回 null。 */
function parseCheck(raw: unknown, issues: RuleSetValidationIssue[], ruleId: string): RuleCheck | null {
  const record = asRecord(raw)
  if (record === null || typeof record.type !== 'string') {
    issues.push({ ruleId, message: `rule ${ruleId}: check 必须是对象且含 type` })
    return null
  }
  const type = record.type as RuleCheckType
  if (!CHECK_TYPES.includes(type)) {
    issues.push({ ruleId, message: `rule ${ruleId}: 未知检查类型 "${record.type}"` })
    return null
  }
  switch (type) {
    case 'keyword_blocklist': {
      const keywords = asStringArray(record.keywords)
      if (keywords === null || !hasNonEmptyWord(keywords) || !hasUsableKeywordEntry(keywords)) {
        issues.push({
          ruleId,
          message: `rule ${ruleId}: keyword_blocklist 需要至少一个非空关键词（空串、纯空白与只含分隔符的条目不会命中任何文本）`,
        })
        return null
      }
      // 空表、非法类型与全空串元素同责：三种形态都让词表在消费侧恒不生效（元素被
      // hasNegationContext 的 word.length > 0 守卫丢弃），静默丢弃会让资产作者以为
      // 放行词已生效，补丁路径（patent-compliance 的 parseActivationPatch）对同一输入
      // 已告警，两侧判据保持一致。带首尾空白的元素保留——它按字面参与匹配，会生效。
      const additionalNegationWords = asStringArray(record.additionalNegationWords)
      let negationWords: string[] | undefined
      if (record.additionalNegationWords !== undefined) {
        if (additionalNegationWords === null || !hasNonEmptyWord(additionalNegationWords)) {
          issues.push({ ruleId, message: `rule ${ruleId}: additionalNegationWords 必须是非空字符串数组，已忽略` })
        } else {
          negationWords = additionalNegationWords
        }
      }
      // 两键正交：词表不开启过滤，缺开关即"声明了却不生效"——必须显式告警
      // （默认词表是否启用同样只看 negationContext，故这里用 `!== true` 覆盖显式 false）。
      if (negationWords !== undefined && record.negationContext !== true) {
        issues.push({
          ruleId,
          message: `rule ${ruleId}: 声明了 additionalNegationWords 但未开 negationContext: true，放行词不会生效`,
        })
      }
      if (record.negationContext !== undefined && typeof record.negationContext !== 'boolean') {
        issues.push({ ruleId, message: `rule ${ruleId}: negationContext 必须是布尔值，已按 false 处理` })
      }
      // severityIfFound 非法值忽略（保持 RuleSeverity 不变量），但必须让资产作者看见。
      const severityIfFound = SEVERITIES.includes(record.severityIfFound as RuleSeverity)
        ? (record.severityIfFound as RuleSeverity)
        : undefined
      if (record.severityIfFound !== undefined && severityIfFound === undefined) {
        issues.push({
          ruleId,
          message: `rule ${ruleId}: severityIfFound 必须是 ${SEVERITIES.join('/')} 之一，已忽略`,
        })
      }
      if (record.quoteImmune !== undefined && typeof record.quoteImmune !== 'boolean') {
        issues.push({ ruleId, message: `rule ${ruleId}: quoteImmune 必须是布尔值，已忽略` })
      }
      return {
        type,
        keywords,
        negationContext: record.negationContext === true,
        ...(negationWords !== undefined ? { additionalNegationWords: negationWords } : {}),
        ...(severityIfFound !== undefined ? { severityIfFound } : {}),
        ...(record.quoteImmune === true ? { quoteImmune: true } : {}),
      }
    }
    case 'pattern_analysis': {
      const patterns = asStringArray(record.patterns)
      if (patterns === null || patterns.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: pattern_analysis 需要非空 patterns` })
        return null
      }
      if (!validateRegexPatterns(patterns, ruleId, issues)) return null
      const validMinMatches = typeof record.minMatches === 'number' && Number.isInteger(record.minMatches) && record.minMatches >= 1
      if (record.minMatches !== undefined && !validMinMatches) {
        issues.push({ ruleId, message: `rule ${ruleId}: minMatches 必须是正整数，已按 1 处理` })
      }
      return { type, patterns, minMatches: validMinMatches ? record.minMatches as number : 1 }
    }
    case 'structural_analysis': {
      if (!Array.isArray(record.requiresAll) || record.requiresAll.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: structural_analysis 需要非空 requiresAll` })
        return null
      }
      const requiresAll: StructuralElementRaw[] = []
      for (const item of record.requiresAll) {
        const el = asRecord(item)
        const patterns = el !== null ? asStringArray(el.patterns) : null
        if (el === null || typeof el.element !== 'string' || patterns === null || patterns.length === 0) {
          issues.push({ ruleId, message: `rule ${ruleId}: requiresAll 元素需要 element + 非空 patterns` })
          return null
        }
        if (!validateRegexPatterns(patterns, ruleId, issues)) return null
        requiresAll.push({
          element: el.element,
          ...(typeof el.description === 'string' ? { description: el.description } : {}),
          patterns,
        })
      }
      return { type, requiresAll, minConfidence: parseMinConfidence(record.minConfidence, ruleId, issues) }
    }
    case 'citation_analysis': {
      const statutes = asRecord(record.statutes)
      if (statutes === null || Object.keys(statutes).length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: citation_analysis 需要非空 statutes` })
        return null
      }
      const parsed: Record<string, { max: number }> = {}
      for (const [name, value] of Object.entries(statutes)) {
        const def = asRecord(value)
        if (def === null || typeof def.max !== 'number') {
          issues.push({ ruleId, message: `rule ${ruleId}: 法条 "${name}" 需要 max 数字` })
          return null
        }
        // topics（主题相关性）没有执行实现。忽略该字段会让作者以为它在判定，
        // 故整条规则不加载。
        if (def.topics !== undefined) {
          issues.push({
            ruleId,
            message: `rule ${ruleId}: 法条 "${name}" 的 topics 不受支持（没有主题相关性判定），删除该字段后该规则才会加载`,
          })
          return null
        }
        parsed[name] = { max: def.max }
      }
      return { type, statutes: parsed }
    }
    case 'synonym_match': {
      if (!Array.isArray(record.requirements) || record.requirements.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: synonym_match 需要非空 requirements` })
        return null
      }
      const requirements: SynonymRequirementRaw[] = []
      for (const item of record.requirements) {
        const el = asRecord(item)
        const keywords = el !== null ? asStringArray(el.keywords) : null
        if (el === null || typeof el.element !== 'string' || keywords === null || !hasNonEmptyWord(keywords)) {
          issues.push({ ruleId, message: `rule ${ruleId}: requirements 元素需要 element + 至少一个非空 keyword` })
          return null
        }
        requirements.push({
          element: el.element,
          ...(typeof el.description === 'string' ? { description: el.description } : {}),
          keywords,
        })
      }
      return { type, requirements, minConfidence: parseMinConfidence(record.minConfidence, ruleId, issues) }
    }
    case 'quote_repetition': {
      const minLength = record.minLength ?? 12
      const minOccurrences = record.minOccurrences ?? 2
      if (typeof minLength !== 'number' || !Number.isInteger(minLength) || minLength < 1) {
        issues.push({ ruleId, message: `rule ${ruleId}: quote_repetition 的 minLength 必须是正整数` })
        return null
      }
      if (typeof minOccurrences !== 'number' || !Number.isInteger(minOccurrences) || minOccurrences < 2) {
        issues.push({ ruleId, message: `rule ${ruleId}: quote_repetition 的 minOccurrences 必须是不小于 2 的整数` })
        return null
      }
      return { type, minLength, minOccurrences }
    }
    case 'empty_section': {
      const minLevel = record.minLevel ?? 2
      if (typeof minLevel !== 'number' || !Number.isInteger(minLevel) || minLevel < 1 || minLevel > 6) {
        issues.push({ ruleId, message: `rule ${ruleId}: empty_section 的 minLevel 必须是 1-6 的整数` })
        return null
      }
      let placeholders: string[] | undefined
      if (record.placeholders !== undefined) {
        const parsed = asStringArray(record.placeholders)
        if (parsed === null || !hasNonEmptyWord(parsed)) {
          issues.push({ ruleId, message: `rule ${ruleId}: empty_section 的 placeholders 必须是非空字符串数组` })
          return null
        }
        placeholders = parsed
      }
      return { type, minLevel, ...(placeholders === undefined ? {} : { placeholders }) }
    }
    case 'sentence_repetition': {
      const minLength = record.minLength ?? 12
      const minOccurrences = record.minOccurrences ?? 3
      if (typeof minLength !== 'number' || !Number.isInteger(minLength) || minLength < 1) {
        issues.push({ ruleId, message: `rule ${ruleId}: sentence_repetition 的 minLength 必须是正整数` })
        return null
      }
      if (typeof minOccurrences !== 'number' || !Number.isInteger(minOccurrences) || minOccurrences < 2) {
        issues.push({ ruleId, message: `rule ${ruleId}: sentence_repetition 的 minOccurrences 必须是不小于 2 的整数` })
        return null
      }
      return { type, minLength, minOccurrences }
    }
    case 'notice_ground_coverage':
      // 双输入检查族：无参数，形状即类型；被判定的输入由 rule_check 的 notice 携带。
      return { type }
    case 'unraised_statute_citation':
      return { type }
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new check type here. */
    default:
      return assertNever(type, 'rule check type')
  }
}

/**
 * 解析单条规则；非法返回 null 并收集问题。
 * @param raw - YAML 里的一条规则。
 * @param issues - 加载期问题收集器。
 * @param where - 条目位置，用于非对象条目的诊断（如 `rules[0]`）。
 * @returns 解析出的规则；条目非法时为 null。
 */
function parseRule(raw: unknown, issues: RuleSetValidationIssue[], where: string): ConstitutionalRule | null {
  const record = asRecord(raw)
  if (record === null) {
    issues.push({ message: `${where}: 条目必须是对象，已跳过` })
    return null
  }
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) {
    issues.push({ message: 'rule: 缺少 id' })
    return null
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    issues.push({ ruleId: id, message: `rule ${id}: 缺少 name` })
    return null
  }
  const severity = record.severity as RuleSeverity
  if (!SEVERITIES.includes(severity)) {
    issues.push({ ruleId: id, message: `rule ${id}: severity 必须是 ${SEVERITIES.join('/')}` })
    return null
  }
  // action 来自 YAML，可能缺省；收紧可空类型以保留缺省回退
  const action = (record.action as RuleAction | undefined) ?? 'warn'
  if (!ACTIONS.includes(action)) {
    issues.push({ ruleId: id, message: `rule ${id}: action 必须是 ${ACTIONS.join('/')}` })
    return null
  }
  const check = parseCheck(record.check, issues, id)
  if (check === null) return null
  const premise = parsePremise(record.premise, id, issues)
  return {
    id,
    name: record.name,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.domain === 'string' ? { domain: record.domain } : {}),
    ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
    severity,
    action,
    ...(typeof record.legalBasis === 'string' ? { legalBasis: record.legalBasis } : {}),
    ...(premise !== undefined ? { premise } : {}),
    check,
  }
}

/**
 * 校验规则集：id 唯一性 + 整体结构。
 * 返回问题列表（空 = 通过）。规则级问题在 parseRule 阶段已收集。
 * @param ruleSet - 待校验的规则集。
 * @param source - 规则集来源（用于问题定位）。
 * @returns 校验问题列表（空 = 通过）。
 */
export function validateRuleSet(ruleSet: RuleSet, source?: string): RuleSetValidationIssue[] {
  const issues: RuleSetValidationIssue[] = []
  const seen = new Set<string>()
  for (const rule of ruleSet.rules) {
    if (seen.has(rule.id)) {
      issues.push({ ...(source !== undefined ? { source } : {}), ruleId: rule.id, message: `rule ${rule.id}: 重复的规则 id` })
    }
    seen.add(rule.id)
  }
  return issues
}

/**
 * 从 YAML 文本解析规则集。支持 rules 数组与映射两种形态。
 * 返回 null 表示整体解析失败（非规则级错误）。
 * @param yamlText - YAML 文本。
 * @param source - 来源标签（用于问题定位）。
 * @returns 解析出的规则集与校验问题列表。
 */
export function parseRuleSetFromYaml(
  yamlText: string,
  source = '<inline>',
): { ruleSet: RuleSet; issues: RuleSetValidationIssue[] } {
  const doc = parseDocument(yamlText)
  if (doc.errors.length > 0) {
    return {
      ruleSet: { rules: [] },
      /* v8 ignore next -- yaml parse errors always carry a message. */
      issues: [{ source, message: `YAML 解析失败: ${doc.errors[0]?.message ?? 'unknown'}` }],
    }
  }
  const root = asRecord(doc.toJS())
  const issues: RuleSetValidationIssue[] = []
  if (root === null) {
    return { ruleSet: { rules: [] }, issues: [{ source, message: '规则文件顶层必须是对象' }] }
  }
  const rulesRaw = root.rules
  const rules: ConstitutionalRule[] = []
  // 同一文件内 id 重复时保留后出现的规则，与 mergeRuleSets 的覆盖方向一致。
  // 两条都留下会让被替换的 block 规则继续拦截。
  const adoptRule = (rule: ConstitutionalRule): void => {
    const index = rules.findIndex(existing => existing.id === rule.id)
    if (index >= 0) {
      issues.push({ source, ruleId: rule.id, message: `rule ${rule.id}: 重复的规则 id` })
      rules.splice(index, 1)
    }
    rules.push(rule)
  }
  if (Array.isArray(rulesRaw)) {
    for (const [index, item] of rulesRaw.entries()) {
      const rule = parseRule(item, issues, `rules[${String(index)}]`)
      if (rule !== null) adoptRule(rule)
    }
  } else if (asRecord(rulesRaw) !== null) {
    for (const [key, item] of Object.entries(rulesRaw as Record<string, unknown>)) {
      const rule = parseRule(item, issues, `rules.${key}`)
      if (rule !== null) adoptRule(rule)
    }
  } else {
    issues.push({ source, message: '规则文件缺少 rules 字段（数组或映射）' })
  }
  const ruleSet: RuleSet = {
    ...(typeof root.version === 'string' ? { version: root.version } : {}),
    rules,
  }
  issues.push(...validateRuleSet(ruleSet, source))
  return { ruleSet, issues }
}

/**
 * 从文件加载规则集；解析失败抛 RuleSetLoadError。
 * @param path - 规则文件路径。
 * @returns 加载结果（规则集、来源、警告）。
 */
export function loadRuleSetFromFile(path: string): LoadedRuleSet {
  const yamlText = readFileSync(path, 'utf8')
  const { ruleSet, issues } = parseRuleSetFromYaml(yamlText, path)
  // 文件级 fatal：无 ruleId 且非规则级前缀（"rule"）。规则级问题（含缺 id）不
  // 拖垮整个文件——跳过问题规则，保留其余可用规则。
  const fatal = issues.filter(i => i.ruleId === undefined && !i.message.startsWith('rule'))
  if (fatal.length > 0) {
    throw new Error(`规则文件加载失败 ${path}: ${fatal.map(i => i.message).join('; ')}`)
  }
  return { ruleSet, source: path, warnings: issues }
}

/**
 * 从目录加载全部规则文件（.yaml/.yml）；单文件失败跳过并告警。
 * @param dir - 规则目录路径。
 * @returns 加载的规则集、来源与警告。
 */
export function loadRuleSetDir(dir: string): {
  ruleSets: RuleSet[]
  sources: string[]
  warnings: RuleSetValidationIssue[]
} {
  const ruleSets: RuleSet[] = []
  const sources: string[] = []
  const warnings: RuleSetValidationIssue[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    warnings.push({ source: dir, message: `规则目录不存在: ${dir}` })
    return { ruleSets, sources, warnings }
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue
    // pack.yaml 是包清单（见 rule-pack.ts），非规则文件
    if (entry === 'pack.yaml') continue
    const path = join(dir, entry)
    try {
      const loaded = loadRuleSetFromFile(path)
      ruleSets.push(loaded.ruleSet)
      sources.push(loaded.source)
      warnings.push(...loaded.warnings)
    } catch (error) {
      warnings.push({ source: path, message: `跳过损坏规则文件: ${(error as Error).message}` })
    }
  }
  return { ruleSets, sources, warnings }
}

/**
 * 合并多个规则集（后出现的规则按 id 覆盖先前的，便于分层覆盖）。
 * @param ruleSets - 待合并的规则集列表。
 * @param issues - 可选的重复 id 收集器；覆盖仍按后出现的规则生效。
 * @returns 合并后的规则集。
 */
export function mergeRuleSets(ruleSets: RuleSet[], issues?: RuleSetValidationIssue[]): RuleSet {
  const byId = new Map<string, ConstitutionalRule>()
  for (const ruleSet of ruleSets) {
    for (const rule of ruleSet.rules) {
      if (byId.has(rule.id)) {
        issues?.push({ ruleId: rule.id, message: `规则 ${rule.id}: 合并时 id 重复，后出现的规则覆盖先前的规则` })
      }
      byId.set(rule.id, rule)
    }
  }
  return { rules: [...byId.values()] }
}

/**
 * 激活评审补丁（`activation-overrides.yaml` 的单条）。
 *
 * 字段语义分两级：
 *   - `action` / `premise`：**整字段替换**（评审结论「这条规则该降级/升级」/
 *     「这条规则只在该主题出现时才评估」）；
 *   - `addKeywords` / `negationContext` / `additionalNegationWords`：**check 级增补**
 *     （评审结论「这条规则的匹配精度要增强」）——只追加/覆盖开关，不重声明既有 keywords。
 *
 * 增补语义是有意的：`assets/rules/patent/nuo-*.yaml` 是 Sati 侧生成物的逐字镜像，
 * 从上游再同步会静默覆盖手改；而让补丁**重声明**整条 check 又会在仓里造出第二份
 * 必须同步维护的副本。增补式补丁既不改生成物，也不产生副本。
 */
export type ActivationRulePatch = {
  action?: RuleAction
  /** 适用前提（正则列表，语义见 `ConstitutionalRule.premise`）；整字段替换。 */
  premise?: string[]
  /** 追加关键词（`a|b|c` OR 组同样适用），增补既有 keywords 之后。 */
  addKeywords?: string[]
  /** 覆盖否定语境开关。 */
  negationContext?: boolean
  /** 追加领域紧邻前缀放行词（语义见 `KeywordBlocklistCheck.additionalNegationWords`）。 */
  additionalNegationWords?: string[]
}

/** 补丁对象的允许键（含仅作文档用途的 `reason`）；未知键告警，避免拼错键被静默忽略。 */
export const ACTIVATION_PATCH_KEYS: readonly string[] = [
  'action',
  'premise',
  'addKeywords',
  'negationContext',
  'additionalNegationWords',
  'reason',
]

/** 把单条补丁施加到规则上；check 级键施加于非 keyword_blocklist 规则时报 issue 并忽略。 */
function applyActivationPatch(
  rule: ConstitutionalRule,
  patch: ActivationRulePatch,
  issues?: RuleSetValidationIssue[],
): ConstitutionalRule {
  let next: ConstitutionalRule = rule
  if (patch.action !== undefined) next = { ...next, action: patch.action }
  if (patch.premise !== undefined) {
    // 与资产解析器同一判据：空表/非法正则会造出「写了前提却不生效」的补丁，
    // 而补丁是评审结论的机器可读形态，静默失效等于评审没做。
    if (isUsablePremise(patch.premise)) {
      next = { ...next, premise: patch.premise }
    } else {
      issues?.push({ ruleId: rule.id, message: `激活覆盖 ${rule.id}: premise 必须是非空合法正则数组，已忽略` })
    }
  }
  const hasCheckPatch =
    patch.addKeywords !== undefined ||
    patch.negationContext !== undefined ||
    patch.additionalNegationWords !== undefined
  if (!hasCheckPatch) return next

  const check = next.check
  if (check.type !== 'keyword_blocklist') {
    issues?.push({
      ruleId: rule.id,
      message: `激活覆盖 ${rule.id}: check 级键（addKeywords/negationContext/additionalNegationWords）仅支持 keyword_blocklist，当前为 ${check.type}，已忽略`,
    })
    return next
  }
  const patchedCheck: KeywordBlocklistCheck = {
    ...check,
    ...(patch.addKeywords === undefined ? {} : { keywords: [...check.keywords, ...patch.addKeywords] }),
    ...(patch.negationContext === undefined ? {} : { negationContext: patch.negationContext }),
    ...(patch.additionalNegationWords === undefined
      ? {}
      : { additionalNegationWords: [...(check.additionalNegationWords ?? []), ...patch.additionalNegationWords] }),
  }
  // 两键正交：词表不开启过滤，缺开关即"有词却不生效"——与 parseCheck 的资产校验同一条
  // 判据，补丁路径同样不得静默。判据取**合并后**的词表：补丁用 `negationContext: false`
  // 打在自带词表的规则上（资产里的 EX-SEL-004 即如此），同样造出"关了开关却留着词"的
  // 矛盾组合，只看补丁自身追加的词会漏报。
  if ((patchedCheck.additionalNegationWords?.length ?? 0) > 0 && patchedCheck.negationContext !== true) {
    issues?.push({
      ruleId: rule.id,
      message: `激活覆盖 ${rule.id}: 声明了 additionalNegationWords 但未开 negationContext: true，放行词不会生效`,
    })
  }
  return { ...next, check: patchedCheck }
}

/**
 * 字段级覆盖规则（按 id 施加 `ActivationRulePatch`，不改未覆盖字段）。
 * 与 mergeRuleSets（整条覆盖）互补：用于「评审补丁」场景——只改 action / 前提 / 增补关键词，
 * 而不重写整条规则（避免复制 name/check 等字段漂移）。
 * overrides 中未命中 id 的规则原样保留；**引用不存在 id 的补丁会报 issue**
 * （拼错 id 的补丁此前被静默忽略，等于"评审写了但没生效"）。
 * @param ruleSet - 基础规则集。
 * @param overrides - id → 字段级补丁映射。
 * @param issues - 可选的校验问题收集器（未命中 id 等）。
 * @returns 应用覆盖后的规则集。
 */
export function applyRuleOverrides(
  ruleSet: RuleSet,
  overrides: ReadonlyMap<string, ActivationRulePatch>,
  issues?: RuleSetValidationIssue[],
): RuleSet {
  if (overrides.size === 0) return ruleSet
  const knownIds = new Set(ruleSet.rules.map(rule => rule.id))
  const rules = ruleSet.rules.map((rule) => {
    const patch = overrides.get(rule.id)
    return patch === undefined ? rule : applyActivationPatch(rule, patch, issues)
  })
  for (const id of overrides.keys()) {
    if (!knownIds.has(id)) {
      issues?.push({ ruleId: id, message: `激活覆盖 ${id}: 规则集中无此 id（拼写错误或规则已移除），补丁未生效` })
    }
  }
  return {
    ...(ruleSet.version !== undefined ? { version: ruleSet.version } : {}),
    rules,
  }
}
