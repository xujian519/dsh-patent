/**
 * 对比域原子：problem-check（实际解决的技术问题合规检查）。
 *
 * 审查指南第二部分第四章 3.2.1.1：实际解决的技术问题应根据区别特征所能达到的
 * 技术效果客观确定，不得写成区别特征本身，也不得包含解决手段。本原子在创造性
 * 三步法第二步之后读取 `diff` 阶段的产出，做两类确定性校验：
 *
 * - `PROBLEM-EQUALS-FEATURE`：问题文本规范化后与某项区别技术特征相同；
 * - 既有 `problem/atomicChecker.ts` 的四检验：不绑方案、单一因果、可测效果。
 *
 * 不判定技术启示或显而易见性——那属于三步法第三步，且需要语义判断。缺少问题
 * 文本时放行并写明原因，避免把上游输出格式差异当成合规失败；状态值类型错误
 * 仍然降级。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import { readJsonStringArray, tryParseJson } from '../../../llm-json.ts'
import {
  checkAtomic,
  extractTechnicalProblem,
  type AtomicCheckResult,
} from '../../../problem/index.ts'
import { degraded } from './llm.ts'
import { isNonEmptyString, resolveKeyList } from './state-keys.ts'

/** 默认 diff 阶段产出键：工作流阶段 id 与图节点输出键。 */
export const DEFAULT_PROBLEM_DIFF_TEXT_KEYS: readonly string[] = ['diff', 'inventiveness_diff']

/** 默认区别技术特征键（结构化状态或原子产出）。 */
export const DEFAULT_PROBLEM_FEATURE_KEYS: readonly string[] = [
  'distinguishing_features',
  'diff_features',
]

/** 阻断级违规：影响 `problem_check_passed`。 */
const BLOCKING_CODES = new Set(['PROBLEM-EQUALS-FEATURE', 'PROBLEM-SOLUTION-BINDING', 'PROBLEM-MULTI-CAUSAL'])

/** 问题文本中可去除的疑问/目的模板词（不改变技术含义）。 */
const QUESTION_TEMPLATES = /(?:如何|怎样|怎么样|怎么)/g

/** 问题文本中可去除的手段动词：保留名词核心，用于与特征比对。 */
const SOLUTION_VERBS = /(?:通过|设置|增设|布置|安装|配置|采用|使用|引入|加装|利用|依靠|借助)/g

/** 特征文本中的泛化结构尾词。 */
const GENERIC_STRUCTURE_TAIL = /(?:的)?(?:技术)?(?:方案|方法|结构|装置|布局)?$/

/** 问题文本末尾的“的问题”等冗余。 */
const PROBLEM_TAIL = /(?:的)?(?:技术)?问题$/

/** 平面文本中的区别特征行。 */
const FEATURE_LINE = /区别(?:技术)?特征(?:为|是|包括|：|:)\s*([^。\n；;]{1,300})/

/** 合规结果中的一条违规。 */
export type ProblemCheckViolation = {
  /** 违规代码。 */
  code: string
  /** 阻断级或质量提示。 */
  severity: 'blocking' | 'quality'
  /** 可直接展示给用户的原因。 */
  detail: string
}

/** problem-check 原子：实际解决的技术问题的确定性合规检查。 */
export const problemCheckAtom: Atom = {
  name: 'problem-check',
  description:
    '实际解决的技术问题合规检查（A22.3 第二步）：问题不得写成区别特征自身、不得包含解决手段，并检查单一因果与可测效果',
  category: 'compare',
  inputSchema: [...DEFAULT_PROBLEM_DIFF_TEXT_KEYS, ...DEFAULT_PROBLEM_FEATURE_KEYS],
  outputSchema: ['problem_check_report', 'problem_check_passed', 'problem_check_violations'],
}

/**
 * 读取 diff 文本分段：同一材料在多个键下出现时只保留一次。
 * @param state - 阶段执行态。
 * @param keys - 候选文本键。
 * @returns 去重后的文本分段。
 */
function collectDiffTexts(state: PipelineState, keys: readonly string[]): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const raw = state[key]
    if (!isNonEmptyString(raw)) continue
    const text = raw.trim()
    if (seen.has(text)) continue
    seen.add(text)
    texts.push(text)
  }
  return texts
}

/**
 * 判断候选键里是否存在类型错误的值。
 * @param state - 阶段执行态。
 * @param keys - 待检查的键。
 * @param allowArray - 是否接受字符串数组（特征键接受，diff 文本键不接受）。
 * @returns 首个类型错误的键名，否则 undefined。
 */
function findMalformedKey(
  state: PipelineState,
  keys: readonly string[],
  allowArray: boolean,
): string | undefined {
  for (const key of keys) {
    const raw = state[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string' && !(allowArray && Array.isArray(raw))) return key
  }
  return undefined
}

/**
 * 从一个 diff 文本中读取 JSON 对象：整段或首个对象片段。
 * @param text - diff 阶段产出文本。
 * @returns JSON 对象；无法解析时 undefined。
 */
function readDiffJson(text: string): Record<string, unknown> | undefined {
  const direct = tryParseJson(text)
  if (direct !== undefined) return direct
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  return tryParseJson(text.slice(start, end + 1))
}

/**
 * 从平面文本中读取区别技术特征行。
 * @param text - diff 阶段产出文本。
 * @returns 拆分后的特征列表；没有该行时为空数组。
 */
function readFlatFeatures(text: string): string[] {
  const match = FEATURE_LINE.exec(text)
  if (match?.[1] === undefined) return []
  return match[1]
    .split(/[、，,；;]/)
    .map(feature => feature.trim())
    .filter(feature => feature.length > 0)
}

/**
 * 汇总区别技术特征：结构化状态优先，其次 diff JSON 与平面文本。
 * @param state - 阶段执行态。
 * @param texts - diff 文本分段。
 * @param featureKeys - 结构化特征键。
 * @returns 去重后的特征列表。
 */
function collectFeatures(
  state: PipelineState,
  texts: readonly string[],
  featureKeys: readonly string[],
): string[] {
  const features: string[] = []
  for (const key of featureKeys) {
    const raw = state[key]
    if (Array.isArray(raw)) features.push(...readJsonStringArray(raw))
    else if (isNonEmptyString(raw)) features.push(raw.trim())
  }
  for (const text of texts) {
    const parsed = readDiffJson(text)
    if (parsed !== undefined) features.push(...readJsonStringArray(parsed['distinguishing_features']))
    features.push(...readFlatFeatures(text))
  }
  return [...new Set(features)]
}

/**
 * 汇总实际解决的技术问题：JSON 字段优先，其次平面文本句。
 * @param texts - diff 文本分段。
 * @returns 问题文本；全部缺失时 undefined。
 */
function collectProblem(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const parsed = readDiffJson(text)
    if (parsed !== undefined && isNonEmptyString(parsed['actual_technical_problem'])) {
      return parsed['actual_technical_problem'].trim()
    }
    const flat = extractTechnicalProblem(text)?.split(/[；;]/)[0]?.trim()
    if (flat !== undefined && flat.length > 0) return flat
  }
  return undefined
}

/**
 * 规范化技术问题/特征文本，用于“问题是否等于特征本身”的精确比对。
 * @param text - 原始文本。
 * @returns 去掉疑问词、手段动词、泛化尾词与标点后的核心文本。
 */
function normalizeCore(text: string): string {
  let normalized = text.replace(/[\s，。；、：:,.!?！？"'“”‘’（）()[\]]/g, '')
  normalized = normalized.replace(QUESTION_TEMPLATES, '')
  normalized = normalized.replace(PROBLEM_TAIL, '')
  normalized = normalized.replace(SOLUTION_VERBS, '')
  normalized = normalized.replace(GENERIC_STRUCTURE_TAIL, '')
  return normalized
}

/**
 * 判断问题文本是否只是某项区别特征的复述。
 * @param problem - 规范化前的问题文本。
 * @param features - 区别技术特征。
 * @returns 命中的特征文本；未命中时 undefined。
 */
function findFeatureRestatement(problem: string, features: readonly string[]): string | undefined {
  const normalizedProblem = normalizeCore(problem)
  if (normalizedProblem.length < 2) return undefined
  for (const feature of features) {
    const normalizedFeature = normalizeCore(feature)
    if (normalizedFeature.length < 2) continue
    if (normalizedProblem === normalizedFeature) return feature
  }
  return undefined
}

/**
 * 把既有四检验映射为违规条目。
 * @param result - `checkAtomic` 的四检验结果。
 * @returns 阻断级与质量级违规。
 */
function atomicViolations(result: AtomicCheckResult): ProblemCheckViolation[] {
  const violations: ProblemCheckViolation[] = []
  if (!result.checks.noSolutionBinding) {
    violations.push({
      code: 'PROBLEM-SOLUTION-BINDING',
      severity: 'blocking',
      detail: '问题表述包含解决手段；技术问题不得包含任何具体手段（指南第二部分第四章 3.2.1.1）',
    })
  }
  if (!result.checks.singleCausality) {
    violations.push({
      code: 'PROBLEM-MULTI-CAUSAL',
      severity: 'blocking',
      detail: '问题表述含多个因果连接词，疑似捆绑或复合问题；请拆分或明确主因',
    })
  }
  if (!result.checks.measurableEffect) {
    violations.push({
      code: 'PROBLEM-UNMEASURED',
      severity: 'quality',
      detail: '问题表述缺少可测指标；建议落到量化效果（如“断裂率从 0.1% 升至 3%”）',
    })
  }
  return violations
}

/**
 * 生成报告：结论、被校验的问题、特征数量与逐条违规。
 * @param passed - 是否无阻断级违规。
 * @param problem - 实际解决的技术问题。
 * @param features - 区别技术特征。
 * @param violations - 全部违规。
 * @returns 可读报告。
 */
function buildReport(
  passed: boolean,
  problem: string,
  features: readonly string[],
  violations: readonly ProblemCheckViolation[],
): string {
  const head = `实际解决的技术问题合规检查（A22.3 第二步）：${passed ? '通过' : '未通过'}`
  const lines = [
    head,
    `- 技术问题：${problem}`,
    `- 区别技术特征：${String(features.length)} 项`,
  ]
  if (features.length === 0) {
    lines.push('- 未提供区别技术特征，跳过“问题是区别特征本身”检查')
  }
  for (const violation of violations) {
    const tag = violation.severity === 'blocking' ? '阻断' : '提示'
    lines.push(`- [${tag}] ${violation.detail}`)
  }
  return lines.join('\n')
}

/** problem-check 执行器：读取 diff 产出并校验实际解决的技术问题。 */
export class ProblemCheckHandler implements StageHandler {
  readonly name = 'problem-check'
  readonly category = 'compare' as const

  /**
   * 执行技术问题合规检查。
   * @param input - 阶段执行输入（state 携带 diff 产出与区别特征）。
   * @returns `problem_check_report`（主输出）、是否通过、违规列表。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const diffKeys = resolveKeyList(state, 'diff_text_keys', DEFAULT_PROBLEM_DIFF_TEXT_KEYS)
    if (diffKeys === undefined) {
      return degraded('problem-check', 'params.diff_text_keys 必须是非空字符串数组')
    }
    const featureKeys = resolveKeyList(state, 'feature_keys', DEFAULT_PROBLEM_FEATURE_KEYS)
    if (featureKeys === undefined) {
      return degraded('problem-check', 'params.feature_keys 必须是非空字符串数组')
    }

    const malformedDiff = findMalformedKey(state, diffKeys, false)
    if (malformedDiff !== undefined) {
      return degraded('problem-check', `state.${malformedDiff} 不是字符串`)
    }
    const malformedFeature = findMalformedKey(state, featureKeys, true)
    if (malformedFeature !== undefined) {
      return degraded('problem-check', `state.${malformedFeature} 不是字符串或字符串数组`)
    }

    const texts = collectDiffTexts(state, diffKeys)
    const problem = collectProblem(texts)
    if (problem === undefined) {
      // 没有技术问题就没有可校验的对象：报告如实写未执行，passed 不能写 true，否则
      // 创造性流程会把一个阻断级法条的未评估项读成通过。
      return {
        problem_check_report: '实际解决的技术问题合规检查（A22.3 第二步）：未提取到实际解决的技术问题，本次未执行（不计为通过）',
        problem_check_passed: false,
        problem_check_violations: [],
      }
    }

    const features = collectFeatures(state, texts, featureKeys)
    const restated = findFeatureRestatement(problem, features)
    const violations: ProblemCheckViolation[] = []
    if (restated !== undefined) {
      violations.push({
        code: 'PROBLEM-EQUALS-FEATURE',
        severity: 'blocking',
        detail: `问题表述是区别特征自身的复述：“${restated}”；技术问题应落到区别特征带来的技术效果`,
      })
    }
    violations.push(...atomicViolations(checkAtomic(problem)))
    const passed = violations.every(violation => !BLOCKING_CODES.has(violation.code))
    return {
      problem_check_report: buildReport(passed, problem, features, violations),
      problem_check_passed: passed,
      problem_check_violations: violations,
    }
  }
}
