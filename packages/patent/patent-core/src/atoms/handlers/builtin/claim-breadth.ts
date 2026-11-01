/**
 * 撰写域原子：claim-breadth（A26.4 概括范围实体判定）。
 *
 * 确定性规则无法判断上位概括是否得到说明书支持，这里让模型逐条给出判定与说明书
 * 摘录，再用 {@link locateQuote} 复核摘录是否真的出现在说明书原文中：
 *
 * - 每条记录对应一个上位概括：权利要求项号、上位表达、支撑摘录、并列下位实施方式
 *   与判定；
 * - 摘录为空或未命中原文时按未通过处理，不允许降级成「通过但无依据」；
 * - 缺陷覆盖四类：无实施例支撑、并列下位之一效果不一致、功能性限定缺实施方式、
 *   权要用语与说明书术语不一致。
 *
 * `claim_breadth_report` 与 `claim_breadth_passed` 由 {@link buildClaimBreadthResult}
 * 同时产出：报告存在而判定缺失的组合没有构造路径。本项保持 warn 级，不阻断交付；
 * 人工校准达标后才讨论升级为 block。
 */

import { type AnchorRange, type AnchorReason, locateQuote } from '../../../anchor/index.ts'
import { deriveClaimRefs } from '../../../claim-chart/runtime/claim-refs.ts'
import { splitClaimSegments } from '../../../claim-chart/runtime/element-validator.ts'
import { parseOptionalJsonStringArray, readJsonString } from '../../../llm-json.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import { degraded, requireLlm } from './llm.ts'
import { readQuoteStageContext, requestRecords, sourceBlocks } from './quote-stage.ts'

/** A26.4 概括范围的缺陷类型；`none` 表示该上位概括未发现缺陷。 */
export type ClaimBreadthDefect =
  | 'none'
  | 'no-embodiment-support'
  | 'parallel-lower-level-gap'
  | 'functional-limitation-without-embodiment'
  | 'term-inconsistency'

/** 缺陷类型的中文标签，供报告与调用方展示。 */
const DEFECT_LABELS: Record<ClaimBreadthDefect, string> = {
  none: '未发现缺陷',
  'no-embodiment-support': '上位概括无实施例支撑',
  'parallel-lower-level-gap': '并列下位中有不能解决同一技术问题的',
  'functional-limitation-without-embodiment': '功能性限定缺实施方式',
  'term-inconsistency': '权要用语与说明书术语不一致',
}

/** 一条上位概括的判定记录。 */
export type ClaimBreadthRecord = {
  /** 权利要求项号。 */
  claim_no: number
  /** 权利要求中的上位表达。 */
  generalization: string
  /** 模型给出的说明书支撑摘录；缺失时为空串。 */
  quote: string
  /** 摘录在说明书原文中的命中区间，`end` 为开区间；仅命中时出现。 */
  anchor?: AnchorRange
  /** 锚点判定来源；`not-found` 与 `empty` 一律按未支持处理。 */
  anchor_reason: AnchorReason
  /** 说明书中与该上位概括对应的并列下位实施方式。 */
  parallel_lower_levels: string[]
  /** 模型判断：并列下位是否都能解决同一技术问题、达到同一效果。 */
  all_parallel_same_effect: boolean
  /** 模型判定的缺陷类型。 */
  defect: ClaimBreadthDefect
  /** 模型给出的判定说明。 */
  reason: string
  /** 程序复核后的结论：无缺陷、并列下位一致且摘录命中原文。 */
  passed: boolean
}

/**
 * `claim-breadth` 的业务输出。两个判定键同为必填：报告与结论只由
 * {@link buildClaimBreadthResult} 一个构造路径产出。
 */
export type ClaimBreadthResult = {
  /** 主输出：逐条上位概括判定报告。 */
  claim_breadth_report: string
  /** 是否所有上位概括都通过（且至少记录了一条）。 */
  claim_breadth_passed: boolean
  /** 逐条记录；顺序与模型返回一致。 */
  claim_breadth_records: ClaimBreadthRecord[]
  /** 未通过记录的标识（`C{权项号}「上位表达」`）。 */
  claim_breadth_failed: string[]
}

/** claim-breadth 原子：A26.4 带原文锚点的逐条概括范围判定。 */
export const claimBreadthAtom: Atom = {
  name: 'claim-breadth',
  description:
    '权利要求概括范围（A26.4）实体判定：逐条列出权利要求中的上位概括，由模型给出说明书支撑摘录与并列下位效果判断，程序复核原文锚点后写入 warn 级判定',
  category: 'gate',
  inputSchema: [
    'claims_draft',
    'specification',
    'pfe_triples',
    'merge_result',
    'features',
    'tech_domain',
  ],
  outputSchema: [
    'claim_breadth_report',
    'claim_breadth_passed',
    'claim_breadth_records',
    'claim_breadth_failed',
  ],
  usesModel: true,
}

/** 模型返回的单条记录；字段由程序严格解析后再复核锚点。 */
type ModelRecord = {
  claim_no: number
  generalization: string
  quote: string
  parallel_lower_levels: string[]
  all_parallel_same_effect: boolean
  defect: ClaimBreadthDefect
  reason: string
}

/** 缺陷类型的合法取值。 */
const DEFECTS: readonly ClaimBreadthDefect[] = [
  'none',
  'no-embodiment-support',
  'parallel-lower-level-gap',
  'functional-limitation-without-embodiment',
  'term-inconsistency',
]

/** 概括范围判定的 JSON Schema。 */
const CLAIM_BREADTH_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim_no: { type: 'number', description: '权利要求项号，必须是权利要求书中已有的项号' },
          generalization: { type: 'string', description: '权利要求中的上位表达原文' },
          quote: { type: 'string', description: '说明书原文摘录，逐字引用；没有支撑时留空' },
          parallel_lower_levels: {
            type: 'array',
            items: { type: 'string' },
            description: '说明书中对应的并列下位实施方式；没有时为空数组',
          },
          all_parallel_same_effect: {
            type: 'boolean',
            description: '并列下位是否都能解决同一技术问题、达到同一技术效果',
          },
          defect: {
            type: 'string',
            enum: [...DEFECTS],
            description: '缺陷类型；未发现缺陷时为 none',
          },
          reason: { type: 'string', description: '判定说明，引用实施例编号或术语差异' },
        },
        required: [
          'claim_no',
          'generalization',
          'quote',
          'parallel_lower_levels',
          'all_parallel_same_effect',
          'defect',
          'reason',
        ],
      },
    },
    notes: { type: 'string', description: '整体判定说明（可选）' },
  },
  required: ['records'],
} as const

/**
 * 读取权利要求书中的全部项号。
 * @param claims - 权利要求草稿全文。
 * @returns 升序项号；没有行首编号时按单条权项记为第 1 项。
 */
function claimNumbers(claims: string): number[] {
  const segments = splitClaimSegments(claims)
  return segments.size > 0 ? [...segments.keys()].sort((left, right) => left - right) : [1]
}

/**
 * 读取独立权利要求项号。
 * @param claims - 权利要求草稿全文。
 * @returns 升序独立权项号；无编号时按第 1 项处理。
 */
function independentClaimNumbers(claims: string): number[] {
  const refs = deriveClaimRefs(claims)
  if (refs.length === 0) return [1]
  return refs.filter(ref => ref.claimType === 'independent').map(ref => ref.claimNo).sort((left, right) => left - right)
}

/**
 * 读取一条模型记录；字段缺失或类型不符时返回可直接展示的原因。
 * @param record - 模型返回的对象项。
 * @param index - 数组下标，用于错误文案。
 * @param knownClaimNumbers - 权利要求书中存在的项号。
 * @returns 解析后的记录，或失败原因。
 */
function readModelRecord(
  record: Record<string, unknown>,
  index: number,
  knownClaimNumbers: readonly number[],
): ModelRecord | string {
  const label = `records 第 ${index + 1} 项`
  const claimNo = record['claim_no']
  if (typeof claimNo !== 'number' || !Number.isInteger(claimNo) || claimNo <= 0) {
    return `${label}的 claim_no 不是正整数`
  }
  if (!knownClaimNumbers.includes(claimNo)) {
    return `${label}的 claim_no ${String(claimNo)} 不在权利要求书中`
  }
  const generalization = readJsonString(record['generalization'])
  if (generalization === undefined) return `${label}缺少非空 generalization`
  const quote = typeof record['quote'] === 'string' ? record['quote'] : undefined
  if (quote === undefined) return `${label}（C${String(claimNo)}）的 quote 不是字符串`
  const parallel = parseOptionalJsonStringArray(record['parallel_lower_levels'], `${label}的 parallel_lower_levels`)
  if (!parallel.ok) return parallel.reason
  const allParallelSameEffect = record['all_parallel_same_effect']
  if (typeof allParallelSameEffect !== 'boolean') {
    return `${label}（C${String(claimNo)}）的 all_parallel_same_effect 不是布尔值`
  }
  const defect = record['defect']
  if (typeof defect !== 'string' || !(DEFECTS as readonly string[]).includes(defect)) {
    return `${label}（C${String(claimNo)}）的 defect 不是合法缺陷类型`
  }
  const reason = readJsonString(record['reason'])
  if (reason === undefined) return `${label}（C${String(claimNo)}）缺少非空 reason`
  return {
    claim_no: claimNo,
    generalization,
    quote,
    parallel_lower_levels: parallel.values,
    all_parallel_same_effect: allParallelSameEffect,
    defect: defect as ClaimBreadthDefect,
    reason,
  }
}

/**
 * 复核一条模型记录：缺陷类型、并列下位一致性与原文锚点必须同时成立。
 * @param modelRecord - 模型记录。
 * @param specification - 说明书原文。
 * @returns 写入 `claim_breadth_records` 的记录。
 */
function checkRecord(modelRecord: ModelRecord, specification: string): ClaimBreadthRecord {
  const anchor = locateQuote(modelRecord.quote, specification)
  const passed = modelRecord.defect === 'none'
    && modelRecord.all_parallel_same_effect
    && anchor.matched
  return {
    claim_no: modelRecord.claim_no,
    generalization: modelRecord.generalization,
    quote: modelRecord.quote,
    anchor_reason: anchor.reason,
    ...(anchor.matched && anchor.range !== undefined ? { anchor: anchor.range } : {}),
    parallel_lower_levels: modelRecord.parallel_lower_levels,
    all_parallel_same_effect: modelRecord.all_parallel_same_effect,
    defect: modelRecord.defect,
    reason: modelRecord.reason,
    passed,
  }
}

/**
 * 渲染逐条判定报告。
 * @param records - 复核后的记录。
 * @param notes - 模型整体说明；缺省为空串。
 * @returns 模型可读的中文报告。
 */
function renderClaimBreadthReport(records: readonly ClaimBreadthRecord[], notes: string): string {
  const passedCount = records.filter(record => record.passed).length
  const passed = records.length > 0 && passedCount === records.length
  const lines = [
    `权利要求概括范围判定（A26.4）：${passed ? '通过' : '未通过'}（上位概括 ${String(records.length)} 条，通过 ${String(passedCount)} 条）`,
  ]
  for (const record of records) {
    const anchor = record.anchor === undefined
      ? `锚点 ${record.anchor_reason}`
      : `命中区间 ${String(record.anchor.start)}-${String(record.anchor.end)}`
    const lower = record.parallel_lower_levels.length === 0
      ? '未列出并列下位'
      : `并列下位 ${String(record.parallel_lower_levels.length)} 项（${record.parallel_lower_levels.join('、')}）`
    const sameEffect = record.all_parallel_same_effect ? '是' : '否'
    lines.push(
      `- [${record.passed ? '通过' : '未通过'}] 权利要求 ${String(record.claim_no)}「${record.generalization}」：${lower}；效果一致：${sameEffect}；缺陷：${DEFECT_LABELS[record.defect]}；${anchor}；说明：${record.reason}`,
    )
  }
  const failed = records.filter(record => !record.passed)
    .map(record => `C${String(record.claim_no)}「${record.generalization}」`)
  if (failed.length > 0) lines.push(`未通过的上位概括：${failed.join('、')}`)
  lines.push('说明：每条摘录都由程序经原文锚点复核；摘录为空或未命中原文时按未通过处理。该项为 warn 级，不阻断交付。')
  if (notes !== '') lines.push(`模型说明：${notes}`)
  return lines.join('\n')
}

/**
 * 由同一返回值同时产生报告与判定。
 *
 * 这是 `ClaimBreadthResult` 的唯一构造路径：任何调用方都必须经过它，
 * 因此不存在「写了报告但没写判定」的组合。
 * @param modelRecords - 模型记录。
 * @param specification - 说明书原文。
 * @param independentNumbers - 独立权利要求项号；每条至少需要一条记录。
 * @param notes - 模型整体说明；缺省为空串。
 * @returns 完整业务输出，或结构错误原因。
 */
function buildClaimBreadthResult(
  modelRecords: readonly ModelRecord[],
  specification: string,
  independentNumbers: readonly number[],
  notes: string,
): { ok: true; result: ClaimBreadthResult } | { ok: false; reason: string } {
  const covered = new Set(modelRecords.map(record => record.claim_no))
  const missing = independentNumbers.filter(number => !covered.has(number))
  if (missing.length > 0) {
    return { ok: false, reason: `records 缺少独立权利要求 ${missing.join('、')} 的概括记录` }
  }
  const records = modelRecords.map(record => checkRecord(record, specification))
  return {
    ok: true,
    result: {
      claim_breadth_report: renderClaimBreadthReport(records, notes),
      claim_breadth_passed: records.length > 0 && records.every(record => record.passed),
      claim_breadth_records: records,
      claim_breadth_failed: records
        .filter(record => !record.passed)
        .map(record => `C${String(record.claim_no)}「${record.generalization}」`),
    },
  }
}

/**
 * 按领域给出概括范围的判定口径。
 * @param domain - `state.tech_domain`；未知或缺失按一般领域处理。
 * @returns 附加到提示词的领域说明。
 */
function domainGuidance(domain: string | undefined): string {
  switch (domain) {
    case 'software':
      return '本领域为软件/算法：功能性限定必须给出模块划分、调用层级或输入输出关联；只写“用于实现某功能”而无实施方式的，判功能性限定缺实施方式。'
    case 'chemical':
      return '本领域为化学/组合物：上位概括必须有制备例或效果例覆盖；并列的组分、配比或工艺变体都要能达到同一效果，缺制备例的判无实施例支撑。'
    default:
      return '按具体实施例核对：上位概括需要实施例支撑；并列下位实施方式都要能解决同一技术问题、达到同一效果。'
  }
}

/** claim-breadth 执行器：调用模型逐条判定、复核锚点并一次产出报告与判定。 */
export class ClaimBreadthHandler implements StageHandler {
  readonly name = 'claim-breadth'
  readonly category = 'gate' as const

  /**
   * 执行概括范围判定。
   * @param input - 阶段执行输入（state 携带说明书、权利要求与领域信息）。
   * @returns 完整的 `ClaimBreadthResult`，或降级片段。
   */
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const read = readQuoteStageContext(input.state, 'claim-breadth', { temperature: 0.1, promptLimit: 12000 })
    if (!read.ok) return read.state
    const { temperature, promptLimit, claimsLimit, pfeLimit, specification, claims, pfe, domain } = read.context

    const knownClaimNumbers = claimNumbers(claims)
    const independentNumbers = independentClaimNumbers(claims)

    const missingLlm = requireLlm(input.provider, 'claim-breadth')
    if (missingLlm) return missingLlm

    const prompt = [
      '你是专利审查员，负责判断权利要求是否符合专利法第26条第4款（概括范围得到说明书支持）。',
      '逐条找出权利要求中相对说明书实施例的上位概括，并核对说明书是否以实施例支撑该概括。',
      '要求：',
      '- 每个独立权利要求至少一条记录；同一权利要求有多个上位概括时分别记录；',
      '- claim_no 必须是权利要求书中已有的项号，generalization 写权利要求中的上位表达原文；',
      '- quote 必须逐字摘录说明书原文，不得改写、拼接或转述；没有支撑摘录时留空；',
      '- parallel_lower_levels 列出说明书中对应的并列下位实施方式，没有则留空数组；',
      '- all_parallel_same_effect 判断这些下位实施方式是否都能解决同一技术问题、达到同一技术效果；',
      '- defect 只能取：none（未发现缺陷）、no-embodiment-support（上位概括无实施例支撑）、parallel-lower-level-gap（并列下位中有不能解决同一技术问题的）、functional-limitation-without-embodiment（功能性限定缺实施方式）、term-inconsistency（权要用语与说明书术语不一致）；',
      '- reason 写明判定依据，引用实施例编号或术语差异。',
      domainGuidance(domain),
      '',
      '【独立权利要求项号】',
      dataBlock(independentNumbers.map(number => `C${String(number)}`).join('、')),
      ...sourceBlocks({
        pfe,
        pfeLimit,
        pfeHeading: 'PFIE 参考特征（仅供定位，判定以权利要求与说明书为准）',
        claims,
        claimsLimit,
        specification,
        promptLimit,
      }),
      '请严格输出 JSON：records 为逐条记录数组（claim_no、generalization、quote、parallel_lower_levels、all_parallel_same_effect、defect、reason），notes 为整体判定说明。',
    ].filter(line => line !== '').join('\n')

    const parsed = await requestRecords(
      input.provider,
      'claim-breadth',
      prompt,
      CLAIM_BREADTH_SCHEMA,
      temperature,
      input.signal,
      (record, index) => readModelRecord(record, index, knownClaimNumbers),
    )
    if (!parsed.ok) return parsed.state
    const built = buildClaimBreadthResult(parsed.records, specification, independentNumbers, parsed.notes)
    return built.ok ? built.result : degraded('claim-breadth', built.reason)
  }
}
