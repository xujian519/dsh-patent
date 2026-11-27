/**
 * 测量协议身份:evaluator 提示词模板、协议版本与 evaluationDigest。
 *
 * `goldDigest` 只覆盖金标文本(case 的 statement/rubric 与多轮审查意见);评分器本身的
 * 版本身份由本模块提供:evaluator 提示词模板、evaluator 协议版本、scorer 协议版本与
 * canonical 问题空间一起折成 `evaluationDigest`,写进 `gate.yaml` 与每条 run 记录。
 * 提示词改一个字符、问题空间增删节点或映射,摘要都变;注释、格式与 YAML 键顺序不变。
 * 门槛(thresholds)不进入摘要:门槛是策略不是测量,改门槛不该强制重录基线——它由
 * gate.yaml 的 diff 审计。
 *
 * @module scripts/patent-oas-protocol
 */

import { createHash } from 'node:crypto'

/**
 * evaluator 协议版本:评估实现变化但模板文本不变时(如调用方式、分数解析)由人递增。
 * 模板文本本身的改动不需要递增——模板进入摘要,文本一变摘要即变。
 */
export const EVALUATOR_PROTOCOL_VERSION = 1

/** scorer 协议版本:分数聚合与节点映射算法变化时由人递增。 */
export const SCORER_PROTOCOL_VERSION = 1

/**
 * evaluator 提示词的静态模板;`{slot}` 占位由 {@link fillEvaluatorPrompt} 单趟填充。
 *
 * 模板文本是测量协议的一部分:改任何一个字符都会改变 {@link evaluationDigest}。
 * 槽位名只含字母数字,模板里的 `{"score": ...}` 字面量不会被误认成槽位。
 */
export const EVALUATOR_PROMPT_TEMPLATE = [
  '你是基准评估者。请只依据下列评分维度,对交付物打分,而不是对配置或过程打分。',
  '任务(statement):',
  '{statement}',
  '评分维度({dimensionLabel},满分 {dimensionPoints}):',
  '{dimensionBody}',
  '交付物(deliverable):',
  '{deliverable}',
  '要求:只输出一个 JSON 对象,形如 {"score": 0 到 100 的数};score 是交付物在该维度上的得分率(满分对应 100)。把该 JSON 写入当前工作目录的 {scoreFilename},不要输出其他内容。',
].join('\n')

/**
 * 填充 evaluator 模板:对模板单趟替换,槽位内容不会被二次扫描——任务或交付物文本里
 * 出现 `{statement}` 这类字面量时按原文保留。
 *
 * @param slots 槽位名 → 填充文本;未提供的槽位按原文保留。
 * @returns 填充后的提示词。
 */
export function fillEvaluatorPrompt(slots: Record<string, string>): string {
  return EVALUATOR_PROMPT_TEMPLATE.replace(/\{(\w+)\}/gu, (match, name: string) => slots[name] ?? match)
}

/**
 * 递归键名排序的 JSON:对象按键名的码元序排列,数组保持顺序;`undefined` 的对象属性
 * 跳过(同 JSON 语义),数组与顶层的 `undefined` 读作 `null`。注释与格式不进入解析
 * 结果,键顺序因此不影响摘要。
 *
 * @param value 待序列化的值(应为 YAML/JSON 解析出的纯数据)。
 * @returns canonical JSON 文本。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    return `{${entries.join(',')}}`
  }
  // undefined 在数组与顶层读作 null(对象属性已在上面过滤);其余原始值必出字符串。
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

/** {@link evaluationDigest} 的输入;缺省项取当前协议常量。 */
export interface EvaluationDigestInput {
  /** canonical 问题空间(`loadProblemSpace` 的解析结果)。 */
  problemSpace: unknown
  /** evaluator 提示词模板;缺省为当前模板。 */
  evaluatorTemplate?: string
  /** evaluator 协议版本;缺省为当前版本。 */
  evaluatorVersion?: number
  /** scorer 协议版本;缺省为当前版本。 */
  scorerVersion?: number
}

/**
 * 测量协议摘要:canonical 问题空间 + evaluator 模板 + 两个协议版本折成
 * `sha256:<hex>`。与 `goldDigest` 分工:goldDigest 钉金标文本,本摘要钉评分器。
 *
 * @param input 摘要输入。
 * @returns `sha256:<hex>` 形式的摘要。
 */
export function evaluationDigest(input: EvaluationDigestInput): string {
  const canonical = canonicalJson({
    problemSpace: input.problemSpace,
    evaluatorTemplate: input.evaluatorTemplate ?? EVALUATOR_PROMPT_TEMPLATE,
    evaluatorVersion: input.evaluatorVersion ?? EVALUATOR_PROTOCOL_VERSION,
    scorerVersion: input.scorerVersion ?? SCORER_PROTOCOL_VERSION,
  })
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}
