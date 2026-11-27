/**
 * 宪法规则引擎 — 交付前置门禁（pre-execute）。
 *
 * 交付纪律（先跑哪几个闸门、分析收口之后才能出件）此前只写在 preset 的提示词里：模型
 * 可以不执行它们而直接调用交付工具，失败是静默的——调用记录里分不出「跑过并通过」和
 * 「没跑」。本模块把纪律落成执行点：部署声明「哪个交付工具被调用前，本会话内必须已成功
 * 执行过哪些工具」，未满足即拒绝该次调用，使缺闸门证据的交付件不落盘。
 *
 * 台账以调用方（agent）与案卷键为归属单位：只有本会话内成功返回、且未在结果中声明
 * `blocked: true` 的前置调用才算数，跨会话不继承。声明了案卷的调用只满足同一案卷的交付；
 * 未声明案卷的调用是会话级记录，只在交付的案卷没有专属记录时采用。归属不明的调用
 * （无 agent）一律按未满足处理——无法归属的交付件同样拿不出本会话的闸门证据。
 *
 * 证据条件除字段存在、数组长度与精确值外，还可声明 `matchesDraftTexts`：把交付入参
 * `draft` 经 `filingTextsFromDraft` 投影后的 digest 与前置结果 `evaluated` 里的 digest
 * 比对，证明前置检查读过的文本就是本次交付的文本。`shadow` 模式下不符只观测不拒绝。
 * @module @deepseek-ai/dsh-patent-rule/runtime/delivery-gate
 */

import { contentHash, DraftValidationError, validateSpecDraft, type SpecDraft } from '@deepseek-ai/dsh-patent-core'
import { filingTextsFromDraft } from '@deepseek-ai/dsh-patent-filing'
import { declaredArgsMatch, jsonRecord, type DeclaredArgValue } from './args-match.ts'

/**
 * 一个前置调用结果必须携带的证据条件。
 *
 * 交付门禁原先只认「工具名成功返回过」，于是零字节的 `rule_check` 或另一个模板的
 * 收口记录都能冒充本次交付所需的运行。证据条件把判定落到结果的字段上：身份字段
 * 不符、数组为空或字段缺失的调用仍然算未满足前置。
 */
export type DeliveryEvidenceRequirement = {
  /** 前置工具结果里的顶层字段名。 */
  field: string
  /** 期望的精确值；字符串数组表示取其中任一值。 */
  equals?: string | boolean | string[]
  /** 字段为数组时要求的最小长度。 */
  minItems?: number
  /**
   * 要求该字段（`evaluated` 形态的 `{ digest }` 条目数组）里为每个列出的草案投影
   * 找到 digest 相同的条目：前置检查读过的文本与本次交付的 draft 必须一致。
   * 按 digest 值匹配，不看条目的 `field` 名——`rule_check` 的字段名只有 `text`，
   * 内容可能是权项文本，字段名不可靠。草案缺失或未通过 validateSpecDraft 时无法
   * 核对，该条件不生效（成文工具自己会报结构错误）。空数组与未声明同义
   * （Config 解析给未声明的数组补 `[]`）。
   */
  matchesDraftTexts?: string[]
}

/** 可参与 digest 核对的草案投影名，与 `filingTextsFromDraft` 的返回字段一一对应。 */
export const DRAFT_TEXT_PROJECTIONS = ['text', 'claims', 'abstract', 'title'] as const

/** 草案投影名。 */
export type DraftTextProjection = (typeof DRAFT_TEXT_PROJECTIONS)[number]

/** digest 核对模式：enforce 把不符计入拒绝，shadow 只观测不拒绝。 */
export type DeliveryGateDigestMode = 'shadow' | 'enforce'

/** shadow 模式下一次「仅 digest 不符」的观测细节（交付工具与前置工具名由调用方补上）。 */
export type DeliveryDigestMismatch = {
  /** 未匹配上的投影名。 */
  projections: string[]
  /** 投影名 → 本次 draft 的期望 digest。 */
  expected: Record<string, string>
  /** 前置结果实际携带的 digest。 */
  actual: string[]
}

/** 门禁 digest 核对的一次观测：shadow 下的不符，或草案非法导致的无法核对。 */
export type DeliveryDigestObservation =
  | ({ kind: 'mismatch'; tool: string; prerequisite: string; caseKey?: string } & DeliveryDigestMismatch)
  | { kind: 'unverifiable'; tool: string; prerequisite: string; caseKey?: string }

/** `deliveryGateMissing` 的 digest 核对选项。 */
export type DeliveryGateDigestOptions = {
  /** digest 核对模式；缺省 `enforce`。 */
  mode?: DeliveryGateDigestMode
  /** shadow 模式下的观测回调（不符与无法核对各上报一次）；enforce 不调用。 */
  onObservation?: (observation: DeliveryDigestObservation) => void
}

/** `DeliveryAttemptLedger.evidenceFailure` 的 digest 核对上下文。 */
export type DeliveryDigestCheck = {
  /** 投影名 → 本次 draft 的期望 digest；缺省表示草案无法核对，digest 条件不生效。 */
  expected?: ReadonlyMap<string, string>
  /** digest 核对模式；缺省 `enforce`。 */
  mode?: DeliveryGateDigestMode
  /** shadow 模式下「仅 digest 不符」的上报。 */
  onMismatch?: (mismatch: DeliveryDigestMismatch) => void
}

/** 一次前置调用留下的结果字段，按字段名索引。 */
export type DeliveryEvidence = Readonly<Record<string, unknown>>

/** 一条交付门禁声明：被门禁的工具，以及它被调用前必须已成功执行过的工具。 */
export type DeliveryGateEntry = {
  /** 被门禁的交付工具名。 */
  tool: string
  /** 前置工具名：本会话内须各成功执行过一次。 */
  requires: string[]
  /**
   * 仅对匹配的入参生效的约束：字符串为精确匹配，字符串数组为取值集合。
   * 用于同一个工具的不同交付形态各要各的前置条件（如按 `template` 区分分析与撰写）。
   */
  whenArgs?: Record<string, DeclaredArgValue>
  /**
   * 前置调用结果必须携带的证据，按前置工具名分组。每个条件都成立才算满足：
   * 例如 `rule_check` 的 `evaluated` 非空、`patent_workflow_run` 的 `manifestId`
   * 与本次模板要求的 manifest 一致。未声明的前置工具仍只按成功返回判定。
   */
  evidence?: Record<string, DeliveryEvidenceRequirement[]>
}

/** 解析后的交付门禁声明。 */
export type DeliveryGatePlan = {
  /** 生效的门禁声明（未声明前置调用的条目已剔除）。 */
  entries: DeliveryGateEntry[]
  /** 加载期告警（空声明）。 */
  warnings: string[]
  /** 每个前置工具需要从结果中留存证据的字段。 */
  evidenceFields: Map<string, Set<string>>
}

/** Argument names that name the case a call belongs to, in precedence order. */
const CASE_ARG_NAMES = ['caseId', 'case_id', 'case_dir', 'caseDir'] as const

/**
 * Case key carried by one call's arguments, or undefined when the call names none.
 *
 * The ledger scopes case-named evidence to that case only; a call that names no
 * case is session-scoped, because there is nothing to attribute it to.
 * @param args - the tool call arguments.
 * @returns the trimmed case key, or undefined.
 */
export function caseKeyOfArguments(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const name of CASE_ARG_NAMES) {
    const value = record[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 一次成功的前置调用，及其结果中留存的证据字段。 */
type DeliveryRecord = {
  readonly evidence?: DeliveryEvidence
}

/** 本会话内成功执行过的工具名台账，按归属单位（agent）与案卷键分组。 */
export class DeliveryAttemptLedger {
  readonly #byAgent = new WeakMap<object, Map<string | undefined, Map<string, DeliveryRecord[]>>>()

  /**
   * 记录一次成功返回的调用。
   * @param agent - 调用归属单位（`ToolExecution.agent`）。
   * @param tool - 已完成、未报错且未声明 `blocked: true` 的工具名。
   * @param caseKey - 该调用声明的案卷键；未声明时为 undefined（会话级）。
   * @param evidence - 该调用结果中按门禁声明留存的身份字段。
   */
  record(agent: object, tool: string, caseKey?: string, evidence?: DeliveryEvidence): void {
    let scopes = this.#byAgent.get(agent)
    if (scopes === undefined) {
      scopes = new Map()
      this.#byAgent.set(agent, scopes)
    }
    let tools = scopes.get(caseKey)
    if (tools === undefined) {
      tools = new Map()
      scopes.set(caseKey, tools)
    }
    const record: DeliveryRecord = evidence === undefined ? {} : { evidence }
    const records = tools.get(tool)
    if (records === undefined) {
      tools.set(tool, [record])
      return
    }
    records.push(record)
  }

  /**
   * 该归属单位是否已成功执行过该工具。
   *
   * A case-named query reads only that case's records; when none exist it falls
   * back to session-level records (calls that named no case), which are the only
   * evidence an unscoped prerequisite can leave. Another case's records are
   * never consulted.
   * @param agent - 调用归属单位。
   * @param tool - 被查询的前置工具名。
   * @param caseKey - 本次交付声明的案卷键。
   * @returns 本会话内成功执行过时为 true。
   */
  has(agent: object, tool: string, caseKey?: string): boolean {
    return this.#records(agent, tool, caseKey).length > 0
  }

  /**
   * 是否有一次记录的結果同时满足全部证据条件。
   *
   * 条件不可跨记录拼凑：一次 `ok: true` 的 disclosure 收口与另一次 `ok: false` 的
   * OA 收口不能合起来冒充一次成功的 OA 收口。声明了 `matchesDraftTexts` 的条件按
   * digest 与本次 draft 的投影比对，同样只在同一条记录内成立。
   * @param agent - 调用归属单位。
   * @param tool - 被查询的前置工具名。
   * @param caseKey - 本次交付声明的案卷键。
   * @param requirements - 该前置工具在本次门禁条目上必须携带的证据。
   * @param digests - digest 核对上下文；`expected` 缺省时 digest 条件不生效。
   * @returns 未满足时最近一条记录的模型可读理由；满足或未声明条件时为 undefined。
   */
  evidenceFailure(
    agent: object,
    tool: string,
    caseKey: string | undefined,
    requirements: readonly DeliveryEvidenceRequirement[],
    digests?: DeliveryDigestCheck,
  ): string | undefined {
    if (requirements.length === 0) return undefined
    const records = this.#records(agent, tool, caseKey)
    if (records.some(record => requirements.every(requirement => (
      evidenceFailureReason(record.evidence, requirement, digests?.expected) === undefined
    )))) {
      return undefined
    }
    // shadow 下「非 digest 条件都满足、仅 digest 不符」不判失败：上报观测后放行，
    // 误拒归因材料就是这次观测。观测取最近一条满足非 digest 条件的记录——它才是
    // enforce 语义下「本会通过」的那次前置运行。
    if (digests?.mode === 'shadow' && digests.expected !== undefined) {
      const satisfied = records.findLast(record => requirements.every(requirement => (
        evidenceFailureReason(record.evidence, requirement) === undefined
      )))
      if (satisfied !== undefined) {
        digests.onMismatch?.(digestMismatch(satisfied.evidence, requirements, digests.expected))
        return undefined
      }
    }
    const latest = records.at(-1)?.evidence
    return requirements
      .flatMap((requirement) => {
        const reason = evidenceFailureReason(latest, requirement, digests?.expected)
        return reason === undefined ? [] : [reason]
      })
      .join('；')
  }

  /** 一次查询可见的记录：本案卷与会话级，或未声明案卷时的全部记录。 */
  #records(agent: object, tool: string, caseKey: string | undefined): readonly DeliveryRecord[] {
    const scopes = this.#byAgent.get(agent)
    if (scopes === undefined) return []
    if (caseKey !== undefined) {
      // A case-named delivery reads its own case and the session-level bucket;
      // another case's records never satisfy it.
      return [
        ...scopes.get(caseKey)?.get(tool) ?? [],
        ...scopes.get(undefined)?.get(tool) ?? [],
      ]
    }
    // A delivery that names no case cannot be isolated, so any record made in
    // this session (including one that named a case) is valid evidence.
    const records: DeliveryRecord[] = []
    for (const tools of scopes.values()) records.push(...tools.get(tool) ?? [])
    return records
  }
}

/** `equals` 条件是否命中：字符串为精确匹配，字符串数组为取值集合。 */
function matchesEquals(actual: unknown, equals: string | boolean | string[]): boolean {
  if (Array.isArray(equals)) {
    return typeof actual === 'string' && equals.includes(actual)
  }
  return actual === equals
}

/** 从 `evaluated` 形态的字段值里取出全部 digest 字符串；非数组或条目无 digest 时跳过。 */
function digestEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const digests: string[] = []
  for (const entry of value) {
    const record = jsonRecord(entry)
    if (typeof record?.digest === 'string') digests.push(record.digest)
  }
  return digests
}

/** `matchesDraftTexts` 里未在证据中找到相同 digest 的投影名。 */
function unmatchedProjections(
  actual: unknown,
  projections: readonly string[],
  expected: ReadonlyMap<string, string>,
): string[] {
  const digests = digestEntries(actual)
  return projections.filter((name) => {
    const want = expected.get(name)
    return want === undefined || !digests.includes(want)
  })
}

/** 一条证据条件未满足时的模型可读理由；满足时为 undefined。 */
function evidenceFailureReason(
  evidence: DeliveryEvidence | undefined,
  requirement: DeliveryEvidenceRequirement,
  expected?: ReadonlyMap<string, string>,
): string | undefined {
  const actual = evidence?.[requirement.field]
  if (actual === undefined) return `结果未携带 ${requirement.field}`
  if (requirement.minItems !== undefined && (!Array.isArray(actual) || actual.length < requirement.minItems)) {
    return `结果的 ${requirement.field} 不足 ${requirement.minItems} 项`
  }
  if (requirement.equals !== undefined && !matchesEquals(actual, requirement.equals)) {
    const expectedValue = Array.isArray(requirement.equals)
      ? requirement.equals.join(' / ')
      : String(requirement.equals)
    return `结果的 ${requirement.field} 为 ${JSON.stringify(actual)}，需要 ${expectedValue}`
  }
  if (requirement.matchesDraftTexts !== undefined && expected !== undefined) {
    const mismatched = unmatchedProjections(actual, requirement.matchesDraftTexts, expected)
    if (mismatched.length > 0) {
      return `结果的 ${requirement.field} 与本次 draft 的 ${mismatched.join('、')} 投影不一致，用本次 draft 重跑该前置工具后再交付`
    }
  }
  return undefined
}

/** shadow 观测内容：最近一条记录上未匹配的投影、期望 digest 与实际 digest。 */
function digestMismatch(
  evidence: DeliveryEvidence | undefined,
  requirements: readonly DeliveryEvidenceRequirement[],
  expected: ReadonlyMap<string, string>,
): DeliveryDigestMismatch {
  const projections: string[] = []
  const expectedDigests: Record<string, string> = {}
  let actual: string[] = []
  for (const requirement of requirements) {
    if (requirement.matchesDraftTexts === undefined) continue
    const value = evidence?.[requirement.field]
    actual = digestEntries(value)
    for (const name of unmatchedProjections(value, requirement.matchesDraftTexts, expected)) {
      projections.push(name)
      const want = expected.get(name)
      if (want !== undefined) expectedDigests[name] = want
    }
  }
  return { projections, expected: expectedDigests, actual }
}

/**
 * 解析交付门禁声明：剔除未声明任何前置调用的条目，并收集证据字段。
 *
 * 「声明了门禁却没有前置条件」是配置错误，静默保留会让门禁看起来生效而实际不判，
 * 故每条都进 warnings（调用方记录后仍需人工核对）。证据挂到未声明的工具上是同一类
 * 自包含配置错误；它会让门禁永远等不到那条证据，故在加载期直接失败。
 * @param entries - 部署声明的门禁条目。
 * @returns 运行计划（生效条目、告警、证据字段）。
 * @throws Error when an entry declares evidence for a tool it does not require.
 */
export function resolveDeliveryGate(entries: readonly DeliveryGateEntry[]): DeliveryGatePlan {
  const warnings: string[] = []
  const resolved: DeliveryGateEntry[] = []
  const evidenceFields = new Map<string, Set<string>>()
  for (const entry of entries) {
    if (entry.requires.length === 0) {
      warnings.push(`交付前置门禁 ${entry.tool}: 未声明任何前置调用，该条不生效`)
      continue
    }
    for (const [tool, requirements] of Object.entries(entry.evidence ?? {})) {
      if (!entry.requires.includes(tool)) {
        throw new Error(`交付前置门禁 ${entry.tool}: evidence 声明了不在 requires 中的前置工具 ${tool}`)
      }
      let fields = evidenceFields.get(tool)
      if (fields === undefined) {
        fields = new Set()
        evidenceFields.set(tool, fields)
      }
      for (const requirement of requirements) {
        fields.add(requirement.field)
        for (const name of requirement.matchesDraftTexts ?? []) {
          if (!(DRAFT_TEXT_PROJECTIONS as readonly string[]).includes(name)) {
            throw new Error(
              `交付前置门禁 ${entry.tool}: matchesDraftTexts 声明了未知投影 ${name}（可用：${DRAFT_TEXT_PROJECTIONS.join(' / ')}）`,
            )
          }
        }
      }
    }
    resolved.push(entry)
  }
  return { entries: resolved, warnings, evidenceFields }
}

/**
 * 从前置工具的规范结果中取出声明过的证据字段。
 * @param value - 前置调用返回的规范结果值。
 * @param fields - 该工具需要留存的字段名；未声明证据时为 undefined。
 * @returns 字段到值的证据记录；没有声明字段时为 undefined，结果不是记录时为空记录。
 */
export function deliveryEvidence(
  value: unknown,
  fields: ReadonlySet<string> | undefined,
): DeliveryEvidence | undefined {
  if (fields === undefined || fields.size === 0) return undefined
  const record = jsonRecord(value)
  if (record === null) return {}
  const evidence: Record<string, unknown> = {}
  for (const field of fields) {
    if (Object.hasOwn(record, field)) evidence[field] = record[field]
  }
  return evidence
}

/**
 * 本次交付 draft 的投影 digest；无法核对（未传 draft 或未通过 validateSpecDraft）时为 null。
 *
 * 草案非法不在这里拦：成文工具自己会给出逐条结构错误，门禁把 digest 条件整组跳过，
 * 由调用方按模式决定观测（shadow）还是放行给工具报错（enforce）。
 */
function projectDraftDigests(args: unknown): ReadonlyMap<string, string> | null {
  const record = jsonRecord(args)
  if (record === null || record.draft === undefined) return null
  let draft: SpecDraft
  try {
    draft = validateSpecDraft(record.draft)
  } catch (error) {
    if (error instanceof DraftValidationError) return null
    throw error
  }
  const texts = filingTextsFromDraft(draft)
  return new Map<string, string>([
    ['text', contentHash(texts.text)],
    ['claims', contentHash(texts.claims)],
    ['abstract', contentHash(texts.abstract)],
    ['title', contentHash(texts.title)],
  ])
}

/**
 * 本次调用尚未满足的前置工具名。
 * @param plan - 运行计划。
 * @param ledger - 本会话成功调用台账。
 * @param agent - 调用归属单位；缺省表示无法归属，按未满足处理。
 * @param tool - 本次调用的工具名。
 * @param args - 本次调用的入参（判定 `whenArgs`，并从中取 `draft` 做 digest 核对）。
 * @param digestOptions - digest 核对模式与 shadow 观测回调；缺省按 enforce。
 * @returns 尚未成功执行过的前置工具名（按声明顺序去重）；无缺口时为空数组。
 */
export function deliveryGateMissing(
  plan: DeliveryGatePlan,
  ledger: DeliveryAttemptLedger,
  agent: object | undefined,
  tool: string,
  args: unknown,
  digestOptions?: DeliveryGateDigestOptions,
): string[] {
  const missing = new Map<string, string>()
  const caseKey = caseKeyOfArguments(args)
  const mode = digestOptions?.mode ?? 'enforce'
  // 投影一次调用只算一次：多条门禁条目命中同一交付工具时共用。
  let projected: ReadonlyMap<string, string> | null | undefined
  const draftDigests = (): ReadonlyMap<string, string> | null => {
    if (projected === undefined) projected = projectDraftDigests(args)
    return projected
  }
  for (const entry of plan.entries) {
    if (entry.tool !== tool || !declaredArgsMatch(entry.whenArgs, args)) continue
    for (const required of entry.requires) {
      if (missing.has(required)) continue
      if (agent === undefined || !ledger.has(agent, required, caseKey)) {
        missing.set(required, required)
        continue
      }
      const requirements = entry.evidence?.[required] ?? []
      // Config 解析给未声明的 matchesDraftTexts 补 []（schemastery 的数组缺省），
      // 空数组与未声明同义：不做 digest 核对，也不算「无法核对」。
      const expectsDigests = requirements.some(requirement => (requirement.matchesDraftTexts?.length ?? 0) > 0)
      const expected = expectsDigests ? draftDigests() : null
      if (expectsDigests && expected === null && mode === 'shadow') {
        digestOptions?.onObservation?.({
          kind: 'unverifiable',
          tool,
          prerequisite: required,
          ...(caseKey !== undefined ? { caseKey } : {}),
        })
      }
      const failure = ledger.evidenceFailure(agent, required, caseKey, requirements, {
        ...(expected !== null ? { expected } : {}),
        mode,
        onMismatch: mismatch => digestOptions?.onObservation?.({
          kind: 'mismatch',
          tool,
          prerequisite: required,
          ...(caseKey !== undefined ? { caseKey } : {}),
          ...mismatch,
        }),
      })
      if (failure !== undefined) missing.set(required, `${required}（${failure}）`)
    }
  }
  return [...missing.values()]
}

/**
 * 渲染拒绝理由：模型据此知道该补哪一步，而不是只看到「被拒」。
 * @param tool - 被拒绝的工具名。
 * @param missing - 尚未满足的前置工具名。
 * @returns 模型可读的拒绝理由。
 */
export function renderDeliveryGateDenial(tool: string, missing: readonly string[]): string {
  return [
    `交付前置门禁拒绝 ${tool}：前置证据不满足 ${missing.join('、')}。`,
    '先执行这些工具并确认其结论通过、结果与本次交付所需的内容一致，再重新调用该工具；门禁认的是本会话内成功返回且证据匹配的调用记录，缺记录即为未跑。',
  ].join('\n')
}

/**
 * 渲染一次 digest 观测（shadow 模式的日志行）：点名交付工具、前置工具、案卷与不符的
 * 投影，附上期望与实际 digest，误拒归因不需要重放会话。
 * @param observation - digest 核对的一次观测。
 * @returns 单行日志文本。
 */
export function renderDeliveryDigestObservation(observation: DeliveryDigestObservation): string {
  const scope = observation.caseKey === undefined ? '' : `（案卷 ${observation.caseKey}）`
  if (observation.kind === 'unverifiable') {
    return `交付前置门禁 digest 观测${scope}：${observation.tool} 的草案未通过结构校验，${observation.prerequisite} 的文本一致性无法核对，按无法核对放行`
  }
  const expected = Object.entries(observation.expected).map(([name, digest]) => `${name}=${digest}`).join('，')
  return [
    `交付前置门禁 digest 观测${scope}：${observation.tool} 与 ${observation.prerequisite} 的文本不一致`,
    `缺失投影：${observation.projections.join('、')}；期望 ${expected}；实际 ${observation.actual.join('，') || '（无 digest 条目）'}`,
  ].join('；')
}
