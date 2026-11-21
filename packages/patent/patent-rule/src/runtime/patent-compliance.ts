/**
 * 宪法规则引擎 — 内置资产加载（专利合规规则）。
 *
 * 资产路径定位（dsh 适配）：包内 assets/rules/patent/，可经 `rulesDir`
 * 覆盖项替换基础资产根（布局镜像 assets/rules/）。基础合规资产缺失或损坏时
 * 抛 {@link PatentRuleAssetError}：空规则集会让门禁静默放行，不能作为安装
 * 故障的降级结果。单个后续规则文件损坏仍只告警并跳过。
 * @module @deepseek-ai/dsh-patent-rule/runtime/patent-compliance
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readYamlRecord } from './yaml-asset.ts'
import type { RuleSet, RuleSetValidationIssue } from '@deepseek-ai/dsh-patent-core'
import {
  ACTIVATION_PATCH_KEYS,
  applyRuleOverrides,
  asRecord,
  asStringArray,
  hasNonEmptyWord,
  hasUsableKeywordEntry,
  isRuleAction,
  isSafeRegex,
  isUsablePremise,
  loadRuleSetFromFile,
  mergeRuleSets,
  type ActivationRulePatch,
} from './RuleLoader.ts'
import { candidateRuleDirs } from '../asset-location.ts'

const COMPLIANCE_FILE = 'compliance.yaml'
const ELECTRICAL_FILE = 'electrical-section-h.yaml'
const ACTIVATION_OVERRIDES_FILE = 'activation-overrides.yaml'

/**
 * nuo 专利规则文件清单。显式列出而非扫目录：rules/patent/ 还含 evidence-rules.yaml
 * （证据引擎自有格式）、synonyms.yaml（同义词资产）等非宪法规则文件，扫目录会误加载产生噪音。
 */
const NUO_RULE_FILES = [
  'nuo-compliance-enforceable.yaml',
  'nuo-patent-core-rules.yaml',
  'nuo-patent-examination-rules.yaml',
  'nuo-patent-ipc-rules.yaml',
  'nuo-patent-judgment-rules.yaml',
  'nuo-patent-law.yaml',
  'nuo-patent-practice-rules.yaml',
] as const

/**
 * 手写并入资产清单（非 nuo 生成物镜像）：`current-law.yaml` 是现行法条口径禁令，
 * `mady-gap-rules.yaml` 是上游未镜像且可确定性执行规则的转换子集，
 * `oa-response-form.yaml` 是答复文书形式规则（计数式论证/重复引证/26.3 判准落位）。
 * 与 nuo 清单分开列出，因为两者来源不同——nuo 文件名对应 Sati 侧生成流程，
 * 本清单由本仓手工维护。三类都参与 activation-overrides 补丁（同一合并结果集），
 * 故评审补丁可同时作用于三者。
 */
const MERGED_RULE_FILES = ['current-law.yaml', 'mady-gap-rules.yaml', 'oa-response-form.yaml'] as const

/**
 * 基础合规规则资产缺失或无法解析。门禁不能以空规则集放行，故加载期失败。
 */
export class PatentRuleAssetError extends Error {
  /** Stable failure code for callers that route on the cause. */
  readonly code = 'RULE_ASSET_MISSING' as const

  /**
   * @param message - model/deployment-facing explanation, naming the expected asset.
   * @param options - optional wrapped cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PatentRuleAssetError'
  }
}

/** 专利合规规则集加载结果（规则集、来源、警告）。 */
export type PatentComplianceLoadResult = {
  ruleSet: RuleSet
  source: string | null
  warnings: string[]
}

function loadFirstExistingRuleSet(fileName: string, rulesDir?: string): PatentComplianceLoadResult {
  const warnings: string[] = []
  for (const dir of candidateRuleDirs(rulesDir)) {
    const path = join(dir, fileName)
    if (!existsSync(path)) continue
    try {
      const loaded = loadRuleSetFromFile(path)
      return {
        ruleSet: loaded.ruleSet,
        source: loaded.source,
        warnings: [...warnings, ...loaded.warnings.map(w => w.message)],
      }
    } catch (error) {
      warnings.push(`规则资产加载失败 ${path}: ${(error as Error).message}`)
    }
  }
  return { ruleSet: { rules: [] }, source: null, warnings }
}

/**
 * 加载基础合规规则集；缺失或解析失败时抛 {@link PatentRuleAssetError}。
 * @param rulesDir - 可选的规则根目录覆盖。
 * @returns 加载结果（规则集、来源、警告）。
 * @throws PatentRuleAssetError when the base compliance asset is absent or unreadable.
 */
function loadBaseCompliance(rulesDir?: string): PatentComplianceLoadResult {
  const result = loadFirstExistingRuleSet(COMPLIANCE_FILE, rulesDir)
  if (result.source === null) {
    throw new PatentRuleAssetError(
      `未找到可解析的专利合规规则资产（${COMPLIANCE_FILE}，候选目录：${candidateRuleDirs(rulesDir).join('、')}）；`
      + '门禁不能以空规则集放行，请检查资产目录或重新安装 @deepseek-ai/dsh-patent-rule',
    )
  }
  return result
}

/**
 * 加载内置专利合规规则集；基础资产缺失或损坏时抛错。
 * @param rulesDir - 可选的规则根目录覆盖。
 * @returns 加载结果（规则集、来源、警告）。
 * @throws PatentRuleAssetError when the base compliance asset is absent or unreadable.
 */
export function loadPatentComplianceRuleSet(rulesDir?: string): PatentComplianceLoadResult {
  return loadBaseCompliance(rulesDir)
}

/**
 * 加载电学案件增强规则集（compliance.yaml + electrical-section-h.yaml 合并）。
 * 用于 H 部电学案件的额外审查/撰写约束；找不到电学增强资产时回退到通用合规规则。
 * @param rulesDir - 可选的规则根目录覆盖。
 * @returns 加载结果（规则集、来源、警告）。
 */
export function loadPatentElectricalRuleSet(rulesDir?: string): PatentComplianceLoadResult {
  const base = loadBaseCompliance(rulesDir)
  const extra = loadFirstExistingRuleSet(ELECTRICAL_FILE, rulesDir)
  const merged: RuleSet = {
    version: base.ruleSet.version ?? extra.ruleSet.version ?? '1.0',
    rules: [...base.ruleSet.rules, ...extra.ruleSet.rules],
  }
  return {
    ruleSet: merged,
    source: extra.source ? `${base.source},${extra.source}` : base.source,
    warnings: [...base.warnings, ...extra.warnings],
  }
}

/** 激活评审覆盖补丁：id → 字段级补丁（action 整替换 + check 级增补，见 ActivationRulePatch）。 */
export type ActivationOverrides = {
  byId: Map<string, ActivationRulePatch>
  source: string | null
  warnings: string[]
}

/** 激活覆盖文件的顶层允许键；未知键告警，避免拼错的键被静默忽略。 */
const ACTIVATION_TOP_LEVEL_KEYS: readonly string[] = ['version', 'premise-vocab', 'overrides']

/**
 * 校验前提词表（`premise-vocab`，供 `premise` 以 YAML 锚点引用）。
 * 词表只在此处校验一次：写错的正则在这里显式告警，而不是等某条规则引用它之后才在
 * 评估期失效（那时只剩"规则不生效"这一现象，定位不到词表）。
 */
function validatePremiseVocab(raw: unknown, path: string, warnings: string[]): void {
  if (raw === undefined) return
  const vocab = asRecord(raw)
  if (vocab === null) {
    warnings.push(`激活覆盖文件 ${path}: premise-vocab 必须是映射（名称 → 非空正则数组），已忽略`)
    return
  }
  for (const [name, value] of Object.entries(vocab)) {
    const list = asStringArray(value)
    if (list === null || list.length === 0 || !list.every(isSafeRegex)) {
      warnings.push(`激活覆盖文件 ${path}: premise-vocab.${name} 必须是非空合法正则数组，已忽略`)
    }
  }
}

/** 解析单条补丁对象；无可识别字段时返回 null（并已写入 warnings）。 */
function parseActivationPatch(
  id: string,
  record: Record<string, unknown>,
  warnings: string[],
): ActivationRulePatch | null {
  const patch: ActivationRulePatch = {}

  if (record.action !== undefined) {
    if (!isRuleAction(record.action)) {
      warnings.push(`激活覆盖 ${id}: 非法 action ${JSON.stringify(record.action)}，已跳过`)
      return null
    }
    patch.action = record.action
  }

  if (record.premise !== undefined) {
    const premise = asStringArray(record.premise)
    // 与资产解析器（RuleLoader.parsePremise）同一判据：非空字符串数组 + 逐条正则校验
    // （语法与灾难性回溯）。前提写错会让规则静默不评估或误评估，故整条跳过而不半截应用。
    if (premise === null || !isUsablePremise(premise)) {
      warnings.push(`激活覆盖 ${id}: premise 必须是非空合法正则数组，已跳过`)
      return null
    }
    patch.premise = premise
  }

  for (const key of ['addKeywords', 'additionalNegationWords'] as const) {
    const raw = record[key]
    if (raw === undefined) continue
    const list = asStringArray(raw)
    // 与资产解析器（RuleLoader.parseCheck）同一判据：空表、非法类型、全空白元素与只含
    // 分隔符的 OR 组都整条跳过——它们让表在消费侧恒不生效。带首尾空白的实词保留。
    if (
      list === null
      || (key === 'addKeywords' ? !hasUsableKeywordEntry(list) : !hasNonEmptyWord(list))
    ) {
      warnings.push(`激活覆盖 ${id}: ${key} 必须是非空字符串数组，已跳过`)
      return null
    }
    patch[key] = list
  }

  if (record.negationContext !== undefined) {
    if (typeof record.negationContext !== 'boolean') {
      warnings.push(`激活覆盖 ${id}: negationContext 必须是布尔值，已跳过`)
      return null
    }
    patch.negationContext = record.negationContext
  }

  for (const key of Object.keys(record)) {
    if (!ACTIVATION_PATCH_KEYS.includes(key)) {
      warnings.push(`激活覆盖 ${id}: 未知键 "${key}"（允许：${ACTIVATION_PATCH_KEYS.join(' / ')}），已忽略`)
    }
  }

  if (Object.keys(patch).length === 0) {
    warnings.push(`激活覆盖 ${id}: 无有效字段，已跳过`)
    return null
  }
  return patch
}

/**
 * 加载 nuo 规则激活评审覆盖（activation-overrides.yaml）。
 * 轻量补丁格式：`overrides: { <id>: { action?, premise?, addKeywords?, negationContext?,
 * additionalNegationWords?, reason? } }`（非标准 RuleSet 形态，由本函数专门解析；
 * 字段语义见 `ActivationRulePatch`）。任一字段非法即跳过该条并告警
 * （fail-safe：不应用半截补丁）。文件不存在时返回空补丁 + 警告（不阻塞专利全量规则加载）。
 * @param rulesDir - 可选的规则根目录覆盖。
 * @returns 激活覆盖（byId 映射、来源、警告）。
 */
export function loadActivationOverrides(rulesDir?: string): ActivationOverrides {
  const warnings: string[] = []
  for (const dir of candidateRuleDirs(rulesDir)) {
    const path = join(dir, ACTIVATION_OVERRIDES_FILE)
    if (!existsSync(path)) continue
    try {
      const parsed = readYamlRecord(readFileSync(path, 'utf8'))
      if (parsed.kind === 'parse-error') {
        warnings.push(`激活覆盖文件解析失败 ${path}: ${parsed.message}`)
        continue
      }
      if (parsed.kind === 'not-record') {
        warnings.push(`激活覆盖文件 ${path}: 顶层必须是对象`)
        continue
      }
      const root = parsed.record
      for (const key of Object.keys(root)) {
        if (!ACTIVATION_TOP_LEVEL_KEYS.includes(key)) {
          warnings.push(
            `激活覆盖文件 ${path}: 未知顶层键 "${key}"（允许：${ACTIVATION_TOP_LEVEL_KEYS.join(' / ')}），已忽略`,
          )
        }
      }
      validatePremiseVocab(root['premise-vocab'], path, warnings)
      const raw = asRecord(root['overrides']) ?? {}
      const byId = new Map<string, ActivationRulePatch>()
      for (const [id, value] of Object.entries(raw)) {
        const record = asRecord(value)
        if (record === null) {
          warnings.push(`激活覆盖 ${id}: 覆盖值必须是对象，已跳过`)
          continue
        }
        const patch = parseActivationPatch(id, record, warnings)
        if (patch !== null) byId.set(id, patch)
      }
      return { byId, source: path, warnings }
    } catch (error) {
      warnings.push(`激活覆盖文件加载失败 ${path}: ${(error as Error).message}`)
    }
  }
  warnings.push(
    `未找到激活覆盖资产（${ACTIVATION_OVERRIDES_FILE}）：评审降级不会生效，规则将按原始 action 执行`,
  )
  return { byId: new Map(), source: null, warnings }
}

/**
 * 门禁检查族（语义「命中即违规」）：命中一处即产出一条违规，对任意文本成立，
 * 可以直接作用于工具结果的全文。
 *
 * citation_analysis 只对「引用范围」报违规（条号超出法定条数），引用本身不在文本
 * 里就不产生结果，故与关键词禁令同为命中即违规。empty_section / sentence_repetition
 * 同理：文本里没有空节、没有重复句，就没有可报的对象——它们只在文书确有该缺陷时
 * 出声，不会因为文本「没写某个章节」而报缺失。
 */
export const INCIDENT_GATE_CHECK_TYPES = [
  'keyword_blocklist',
  'pattern_analysis',
  'citation_analysis',
  'quote_repetition',
  'empty_section',
  'sentence_repetition',
] as const

/**
 * 门禁检查族（语义「缺失即违规」）：只有被评估文本本身就是交付制品时才成立。
 * 普通文本天然「缺失」几十个期望要素，把这类规则放进作用于工具结果的门禁会海量
 * 误报，故它们只能经 {@link selectGateRules} 的显式选择，或经制品结构门禁
 * （`structural-gate.ts`，按工具入参取制品文本）执行。
 */
export const ARTIFACT_GATE_CHECK_TYPES = ['structural_analysis', 'synonym_match'] as const

/** 门禁可用的检查类型。 */
export type GateCheckType = (typeof INCIDENT_GATE_CHECK_TYPES)[number] | (typeof ARTIFACT_GATE_CHECK_TYPES)[number]

/** 全部门禁检查类型（供配置解析与校验）。 */
export const GATE_CHECK_TYPES: readonly GateCheckType[] = [
  ...INCIDENT_GATE_CHECK_TYPES,
  ...ARTIFACT_GATE_CHECK_TYPES,
]

/**
 * 判定一个字符串是否为门禁检查类型；配置里的未知取值据此告警而非静默忽略。
 * @param value - 待判定的取值。
 * @returns 是否为门禁检查类型。
 */
export function isGateCheckType(value: string): value is GateCheckType {
  return (GATE_CHECK_TYPES as readonly string[]).includes(value)
}

/** 默认门禁检查族：只有「命中即违规」的关键词禁令，与关键词门禁的历史行为一致。 */
export const DEFAULT_GATE_CHECK_TYPES: readonly GateCheckType[] = ['keyword_blocklist']

/**
 * 输出门禁规则子集：按检查族筛选规则。
 *
 * 默认只保留 keyword_blocklist（compliance 的风险词/审批词/绝对化规则 PAT-RISK-001 /
 * PAT-APPROVAL-001 / PAT-ABS-001，与 nuo 的占位符/商业宣传/公序良俗/清楚性/事后诸葛亮/
 * 编造对比文件等禁令）。部署可经 `patent-rule` 的 `gateCheckTypes` 扩到
 * {@link INCIDENT_GATE_CHECK_TYPES} 里其余命中即违规的族；{@link ARTIFACT_GATE_CHECK_TYPES}
 * 里的缺失即违规规则默认排除，因为对工具结果全文评测时它们对普通文本海量误报，其执行
 * 点是制品结构门禁（按工具声明的入参取制品文本）。
 * @param ruleSet - 待筛选的规则集。
 * @param checkTypes - 保留的检查族；缺省 {@link DEFAULT_GATE_CHECK_TYPES}。
 * @returns 门禁规则子集。
 */
export function selectGateRules(
  ruleSet: RuleSet,
  checkTypes: readonly GateCheckType[] = DEFAULT_GATE_CHECK_TYPES,
): RuleSet {
  const allowed = new Set<string>(checkTypes)
  return {
    ...(ruleSet.version !== undefined ? { version: ruleSet.version } : {}),
    rules: ruleSet.rules.filter(rule => allowed.has(rule.check.type)),
  }
}

/**
 * 加载专利全量规则集（compliance.yaml + nuo-*.yaml + 手写并入资产，经
 * activation-overrides 降级）。
 * 供 rule_check scope=patent-full 与规则驱动输出门禁（B 链）使用。
 * 任一并入文件缺失/损坏均跳过并告警（不拖垮整个规则集）；compliance 基础资产
 * 缺失或损坏时抛 {@link PatentRuleAssetError}，不以空规则集放行。
 * @param rulesDir - 可选的规则根目录覆盖。
 * @returns 加载结果（规则集、来源、警告）。
 * @throws PatentRuleAssetError when the base compliance asset is absent or unreadable.
 */
export function loadPatentFullRuleSet(rulesDir?: string): PatentComplianceLoadResult {
  const base = loadBaseCompliance(rulesDir)
  const mergedSets: RuleSet[] = []
  const warnings = [...base.warnings]
  for (const file of [...NUO_RULE_FILES, ...MERGED_RULE_FILES]) {
    const loaded = loadFirstExistingRuleSet(file, rulesDir)
    if (loaded.source === null) {
      warnings.push(`规则文件未找到: ${file}`)
      continue
    }
    mergedSets.push(loaded.ruleSet)
    warnings.push(...loaded.warnings)
  }
  const mergeIssues: RuleSetValidationIssue[] = []
  const mergedRuleSet = mergeRuleSets(mergedSets, mergeIssues)
  warnings.push(...mergeIssues.map(issue => issue.message))
  const { byId, source: overrideSource, warnings: overrideWarnings } = loadActivationOverrides(rulesDir)
  warnings.push(...overrideWarnings)
  const patchIssues: RuleSetValidationIssue[] = []
  const patched = applyRuleOverrides(mergedRuleSet, byId, patchIssues)
  warnings.push(...patchIssues.map(issue => issue.message))
  const merged: RuleSet = {
    version: base.ruleSet.version ?? patched.version ?? '1.0',
    rules: [...base.ruleSet.rules, ...patched.rules],
  }
  return {
    ruleSet: merged,
    source: overrideSource ? `${base.source}+${overrideSource}` : base.source,
    warnings,
  }
}

/** 每一作业 scope 都并入的通用域：compliance 基础规则（`patent`）与通用实务规则（`patent_general`）。 */
const COMMON_CASE_DOMAINS = ['patent', 'patent_general'] as const

/**
 * 答复类文书（审查意见答复、复审请求、无效答辩）的域集合，三个作业 scope 共用。
 *
 * 构成：通用域 + 答复实践域（逐点回应、答复期限、修改超范围检查）+ 需答复的实体条款域
 * （新颖性 22.2 / 创造性 22.3 / 实用性 22.4 / 充分公开 26.3 / 权利要求 26.4）
 * + 审查程序域（A33 修改不超范围、程序与证据规则）。
 *
 * 三者的交付文书同构：逐点回应对方主张的每一项理由、在期限内答复、修改受 A33 限制。
 * 无效答辩只多一层「对方是请求人而不是审查员」，故与答复共用同一域集合。
 */
const ANSWER_BRIEF_DOMAINS = [
  ...COMMON_CASE_DOMAINS,
  'patent_oa_response',
  'patent_novelty',
  'patent_inventiveness',
  'patent_utility',
  'patent_disclosure',
  'patent_claims',
  'patent_procedure',
] as const

/**
 * 作业类别 scope（`rule_check` 的 scope 取值）。答复、无效、复审、侵权四类与作业
 * manifest 对应；`patent-drafting` / `patent-analysis` 是撰写与分析作业的收敛入口；
 * `patent-invalidation-defense` 与 `patent_invalidation_v1` 同一作业，只是被请求人侧。
 */
export type PatentCaseScope =
  | 'patent-drafting'
  | 'patent-analysis'
  | 'patent-oa-response'
  | 'patent-invalidation'
  | 'patent-invalidation-defense'
  | 'patent-reexamination'
  | 'patent-infringement'

/**
 * 作业 scope → 评估域（`ConstitutionalRule.domain` 的闭集，见 `assets/rules/patent/**`）。
 *
 * 一个 scope 的域 = 通用域 + **本作业交付文书的格式/程序域** + **本作业必须答复或论证的理由条款域**。
 * 域取值全部取自规则资产：资产中没有 `patent_invalidation` / `patent_reexamination` / `patent_amendment`
 * 三个域，无效与复审的实体理由（22.2 / 22.3 / 22.4 / 26.3 / 26.4 / 33 条）在资产里分别落在新颖性、
 * 创造性、实用性、充分公开、权利要求、程序六个域上，故各 scope 的域按其理由来源推导：
 *
 * | scope | 对应 manifest | 理由来源 |
 * | --- | --- | --- |
 * | `patent-drafting` | 撰写作业 | 权利要求/说明书产物 + 客体/新颖性/创造性/实用性 |
 * | `patent-analysis` | 专利性分析作业 | 新颖性/创造性/实用性/充分公开 |
 * | `patent-oa-response` | `patent_oa_response_v1` | 驳回类型表（7 类） |
 * | `patent-invalidation` | `patent_invalidation_v1` | 无效理由表（12 项），**请求人侧** |
 * | `patent-invalidation-defense` | `patent_invalidation_v1` | 无效理由表，**被请求人（专利权人）侧** |
 * | `patent-reexamination` | `patent_reexamination_v1` | 复审理由表（6 项） |
 * | `patent-infringement` | `patent_infringement_v1` | 侵权比对与抗辩 + 诉讼程序/证据 |
 *
 * 七个 scope 的并集覆盖 `patent-full` 里的全部域（测试断言）：任一域的规则都至少有一个作业入口，
 * 新增资产域若不属于任何作业，构建期就会失败而不是只能靠 `patent-full` 触及。
 *
 * 答复、复审与无效答辩今日域集合相同：复审理由表 = 无效理由表 + 实用新型客体缺陷（客体规则在通用域），
 * 且复审请求书与无效答辩意见陈述书都与答复文书同构（逐点回应、A33 限制）。三者仍分列——模型按作业选
 * 入口，不必知道域表；任一作业的资产域分化时（例如上游带来 `patent_invalidation` 域的规则）在此处
 * 拆开，scope 名称不变。无效 scopes 的请求人侧与答辩侧分列：答复实践域（逐点回应、答复期限、禁止计数
 * 式论证、重复引证）的语义是答复对方主张，对**请求书**会误报，对**答辩意见陈述书**正适用；请求人侧
 * 因此不带该域，答辩侧带。侵权 scope 带侵权域与程序域：诉讼程序/证据规则（举证妨碍、技术鉴定、
 * 网络证据）与审查程序规则同处 `patent_procedure`，后者由 premise 在无关文本上静默；撰写形态域
 * 仍不进入侵权 scope，避免权项布局等结构完整性规则对侵权意见书误报。
 */
export const PATENT_CASE_DOMAINS: Record<PatentCaseScope, readonly string[]> = {
  // 撰写：权利要求与说明书产物 + 客体/新颖性/创造性/实用性判断。不含答复实践域，
  // 避免把“逐点回应审查意见”这类答复规则套到草案上。
  'patent-drafting': [
    ...COMMON_CASE_DOMAINS,
    'patent_claims',
    'patent_disclosure',
    'patent_novelty',
    'patent_inventiveness',
    'patent_utility',
  ],
  // 分析报告：专利性/新颖性/创造性结论，不取权利要求撰写形态规则（权项布局、
  // 从属引用等对分析文本是结构性误报）。
  'patent-analysis': [
    ...COMMON_CASE_DOMAINS,
    'patent_novelty',
    'patent_inventiveness',
    'patent_utility',
    'patent_disclosure',
  ],
  'patent-oa-response': ANSWER_BRIEF_DOMAINS,
  'patent-invalidation-defense': ANSWER_BRIEF_DOMAINS,
  'patent-reexamination': ANSWER_BRIEF_DOMAINS,
  'patent-invalidation': [
    ...COMMON_CASE_DOMAINS,
    'patent_novelty',
    'patent_inventiveness',
    'patent_utility',
    'patent_disclosure',
    'patent_claims',
    'patent_procedure',
  ],
  // 侵权意见书同时需要诉讼程序/证据规则（举证妨碍、技术鉴定、网络证据），
  // 这些规则与审查程序规则同处 patent_procedure；后者由 premise 在无关文本上静默。
  'patent-infringement': [...COMMON_CASE_DOMAINS, 'patent_infringement', 'patent_procedure'],
}

/**
 * 解析作业 scope 的评估域；非作业 scope 返回 undefined（调用方据此走全量评估）。
 * @param scope - `rule_check` 的 scope 取值（模型输入，须按自有键判断，不能落到原型链上）。
 * @returns 该作业的域列表；非作业 scope 时为 undefined。
 */
export function patentCaseDomains(scope: string): readonly string[] | undefined {
  return Object.hasOwn(PATENT_CASE_DOMAINS, scope) ? PATENT_CASE_DOMAINS[scope as PatentCaseScope] : undefined
}
