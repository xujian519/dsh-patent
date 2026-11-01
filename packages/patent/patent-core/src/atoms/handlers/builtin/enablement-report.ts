/**
 * 披露域原子：enablement-report（A26.3 充分公开实体判定）。
 *
 * `buildEnablementGraph` 的 `enablement_conclusion` 只给出“是否公开充分”的结论，
 * 不带原文坐标，不能证明结论引用的内容真的写在说明书里。本原子把判定拆成两步：
 *
 * 1. 程序从权利要求原文派生独立权利要求特征（`C{权项号}F{特征序号}`），不依赖模型；
 * 2. 模型只负责为每条特征给出说明书摘录、实施例编号与参数/效果，摘录逐条经
 *    {@link locateQuote} 复核命中区间；任一特征没有命中原文的摘录即判未通过。
 *
 * `enablement_report` 与 `enablement_passed` 由 {@link buildEnablementResult} 同时产出：
 * 报告存在而判定缺失的组合没有构造路径，`legal-gaps` 因此不会把它误读为通过。
 */

import { type AnchorRange, type AnchorReason, locateQuote } from '../../../anchor/index.ts'
import { splitClaimSegments } from '../../../claim-chart/runtime/element-validator.ts'
import { readJsonString } from '../../../llm-json.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
} from '../../handler.ts'
import { degraded, requireLlm } from './llm.ts'
import { readQuoteStageContext, requestRecords, sourceBlocks } from './quote-stage.ts'
import { isRecord } from './state-keys.ts'

/** 一个独立权利要求技术特征；由程序从权利要求原文派生，模型不得增删。 */
type EnablementFeature = {
  /** 特征 ID，形如 `C1F2`：权利要求序号加特征在特征部中的位次。 */
  id: string
  /** 所属权利要求序号。 */
  claimNo: number
  /** 特征原文。 */
  text: string
}

/** 一条逐特征充分公开记录。 */
export type EnablementRecord = {
  /** 对应的权利要求特征 ID。 */
  feature_id: string
  /** 权利要求特征原文，供报告直接引用。 */
  feature: string
  /** 模型给出的说明书摘录；缺失记录时为空串。 */
  quote: string
  /** 实施例标识（如 `实施例1`）；模型未给出时为空串。 */
  embodiment_id: string
  /** 支撑该特征可实现的参数或技术效果；模型未给出时为空串。 */
  parameter_or_effect: string
  /** 该特征是否同时经模型判断与程序锚点复核获得支持。 */
  enabled: boolean
  /** 锚点判定来源；`not-found` 与 `empty` 一律按未支持处理。 */
  anchor_reason: AnchorReason
  /** 摘录在说明书原文中的命中区间，`end` 为开区间；仅命中时出现。 */
  anchor?: AnchorRange
}

/**
 * `enablement-report` 的业务输出。两个判定键同为必填：报告与结论只由
 * {@link buildEnablementResult} 一个构造路径产出，不存在只写其一的返回值。
 */
export type EnablementResult = {
  /** 主输出：逐特征判定报告。 */
  enablement_report: string
  /** 是否每条独立权利要求特征都获得带原文锚点的支持。 */
  enablement_passed: boolean
  /** 逐特征记录；顺序与派生特征一致。 */
  enablement_records: EnablementRecord[]
  /** 未获得支持的请求特征 ID。 */
  enablement_missing: string[]
}

/** enablement-report 原子：A26.3 带原文锚点的逐特征判定。 */
export const enablementReportAtom: Atom = {
  name: 'enablement-report',
  description:
    '充分公开（A26.3）实体判定：从独立权利要求派生特征，逐条在说明书中定位实施例摘录并复核原文锚点，任一特征无命中即判未通过',
  category: 'gate',
  inputSchema: [
    'specification',
    'claims_draft',
    'pfe_triples',
    'merge_result',
    'features',
    'figure_analysis',
    'tech_domain',
  ],
  outputSchema: ['enablement_report', 'enablement_passed', 'enablement_records', 'enablement_missing'],
  usesModel: true,
}

/** 模型返回的单条记录；字段由程序严格解析后再复核锚点。 */
type ModelRecord = {
  feature_id: string
  quote: string
  embodiment_id: string
  parameter_or_effect: string
  enabled: boolean
}

/** 权项行首编号。 */
const CLAIM_NUMBER_PREFIX = /^\s*\d+[.、．]\s*/u

/** 从属权利要求引用（出现即视为从属，不进入特征派生）。 */
const DEPENDENT_REFERENCE = /根据权利要求\s*\d+/u

/** 特征部起标记。 */
const CHARACTERIZING_PART = /其特征在于[，,：:]?\s*/u

/** 特征分隔符：句读与逗号。 */
const FEATURE_SEPARATOR = /[，,；;。]/u

/** 说明书摘录的 JSON Schema。 */
const ENABLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feature_id: { type: 'string', description: '给定特征列表中的 ID，不得新增或改写' },
          quote: { type: 'string', description: '说明书原文摘录，逐字引用' },
          embodiment_id: { type: 'string', description: '实施例标识，如 实施例1' },
          parameter_or_effect: { type: 'string', description: '支撑该特征的参数或技术效果' },
          enabled: { type: 'boolean', description: '该特征是否能够实现' },
        },
        required: ['feature_id', 'quote', 'embodiment_id', 'parameter_or_effect', 'enabled'],
      },
    },
    notes: { type: 'string', description: '判定说明（可选）' },
  },
  required: ['records'],
} as const

/**
 * 取权项正文的特征部文本。
 * @param claimText - 单条权利要求段落（可含行首编号）。
 * @returns 特征部文本；无“其特征在于”时取去掉前序段后的正文。
 */
function claimFeatureBody(claimText: string): string {
  const body = claimText.replace(CLAIM_NUMBER_PREFIX, '')
  const match = CHARACTERIZING_PART.exec(body)
  if (match !== null) return body.slice(match.index + match[0].length)
  const segments = body.split(FEATURE_SEPARATOR).map(part => part.trim()).filter(part => part.length > 0)
  // 无特征部标记时，首个以“一种/一款”开头的分句是前序，不是要公开的技术特征。
  return /^(?:一种|一款)/u.test(segments[0] ?? '') ? segments.slice(1).join('，') : body
}

/**
 * 把一条权利要求拆成技术特征。
 * @param claimText - 单条权利要求段落。
 * @returns 去空白后的特征文本；无特征时为空数组。
 */
function claimFeatureTexts(claimText: string): string[] {
  return claimFeatureBody(claimText)
    .split(FEATURE_SEPARATOR)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * 从权利要求原文派生独立权利要求特征。
 *
 * 依赖程序切分而不是模型拆分：特征 ID 必须由固定规则生成，才能逐条要求模型返回
 * 记录，并把“有没有覆盖”变成可机械核对的问题。
 * @param claims - 权利要求草稿全文。
 * @returns 独立权利要求特征；全部是从属权利要求或没有特征时为空数组。
 */
function deriveFeatures(claims: string): EnablementFeature[] {
  const segments = splitClaimSegments(claims)
  const entries: Array<[number, string]> =
    segments.size > 0 ? [...segments.entries()].sort((left, right) => left[0] - right[0]) : [[1, claims]]
  const features: EnablementFeature[] = []
  for (const [claimNo, text] of entries) {
    if (DEPENDENT_REFERENCE.test(text)) continue
    const texts = claimFeatureTexts(text)
    for (const [index, featureText] of texts.entries()) {
      features.push({ id: `C${claimNo}F${index + 1}`, claimNo, text: featureText })
    }
  }
  return features
}

/**
 * 按领域给出实施例判定口径。
 * @param domain - `state.tech_domain`；未知或缺失按一般领域处理。
 * @returns 附加到提示词的领域判定说明。
 */
function domainGuidance(domain: string | undefined): string {
  switch (domain) {
    case 'software':
      return '本领域为软件/算法：按模块划分、调用层级与各模块的输入输出关联列出实施方式；只有功能描述、没有输入输出关系或执行步骤的，不算能够实现。'
    case 'chemical':
      return '本领域为化学/组合物：以制备例与效果例为依据列出；缺少原料、配比、工艺条件或效果数据的，不算能够实现。'
    default:
      return '按具体实施例列出；缺少实施方式、参数或技术效果的，不算能够实现。'
  }
}

/**
 * 收拢附图标记，供模型把实施例摘录与图面标号对上。
 * @param state - 阶段执行态。
 * @returns 去重后的附图标记列表；无附图分析结果时为空。
 */
function collectFigureRefs(state: PipelineState): string[] {
  const refs: string[] = []
  for (const item of getStateArray(state, 'figure_analysis')) {
    if (!isRecord(item)) continue
    const components = item['components']
    if (!Array.isArray(components)) continue
    for (const component of components) {
      if (!isRecord(component)) continue
      const ref = readJsonString(component['refNumber'])
      if (ref !== undefined) refs.push(ref)
    }
  }
  return [...new Set(refs)]
}

/**
 * 读取一条模型记录；字段缺失或类型不符时返回可直接展示的原因。
 * @param record - 模型返回的对象项。
 * @param index - 数组下标，用于错误文案。
 * @returns 解析后的记录，或失败原因。
 */
function readModelRecord(record: Record<string, unknown>, index: number): ModelRecord | string {
  const featureId = readJsonString(record['feature_id'])
  if (featureId === undefined) return `records 第 ${index + 1} 项缺少非空 feature_id`
  const quote = typeof record['quote'] === 'string' ? record['quote'] : undefined
  if (quote === undefined) return `records 第 ${index + 1} 项（${featureId}）的 quote 不是字符串`
  const embodimentId = readJsonString(record['embodiment_id'])
  if (embodimentId === undefined) return `records 第 ${index + 1} 项（${featureId}）缺少非空 embodiment_id`
  const parameterOrEffect = readJsonString(record['parameter_or_effect'])
  if (parameterOrEffect === undefined) {
    return `records 第 ${index + 1} 项（${featureId}）缺少非空 parameter_or_effect`
  }
  const enabled = record['enabled']
  if (typeof enabled !== 'boolean') return `records 第 ${index + 1} 项（${featureId}）的 enabled 不是布尔值`
  return { feature_id: featureId, quote, embodiment_id: embodimentId, parameter_or_effect: parameterOrEffect, enabled }
}

/** 单条特征的复核结果；`reason` 只在未支持时出现。 */
type CheckedRecord = {
  record: EnablementRecord
  reason?: string
}

/**
 * 复核一条模型记录：模型判断与原文锚点必须同时成立。
 * @param feature - 派生特征。
 * @param modelRecord - 该特征的模型记录；缺失时 undefined。
 * @param specification - 说明书原文。
 * @returns 写入 `enablement_records` 的条目与未支持原因。
 */
function checkFeature(
  feature: EnablementFeature,
  modelRecord: ModelRecord | undefined,
  specification: string,
): CheckedRecord {
  if (modelRecord === undefined) {
    return {
      record: {
        feature_id: feature.id,
        feature: feature.text,
        quote: '',
        embodiment_id: '',
        parameter_or_effect: '',
        enabled: false,
        anchor_reason: 'empty',
      },
      reason: '模型未给出该特征的记录',
    }
  }
  const anchor = locateQuote(modelRecord.quote, specification)
  const supported = modelRecord.enabled && anchor.matched
  const record: EnablementRecord = {
    feature_id: feature.id,
    feature: feature.text,
    quote: modelRecord.quote,
    embodiment_id: modelRecord.embodiment_id,
    parameter_or_effect: modelRecord.parameter_or_effect,
    enabled: supported,
    anchor_reason: anchor.reason,
    ...(anchor.matched && anchor.range !== undefined ? { anchor: anchor.range } : {}),
  }
  if (!modelRecord.enabled) return { record, reason: '模型判定该特征无法实现' }
  if (!anchor.matched) {
    const label = anchor.reason === 'empty' ? '摘录为空' : '摘录未在说明书中命中'
    return { record, reason: label }
  }
  return { record }
}

/**
 * 渲染逐特征判定报告。
 * @param checked - 复核后的逐特征记录，含未支持原因。
 * @param notes - 模型判定说明；缺省为空串。
 * @returns 模型可读的中文报告。
 */
function renderEnablementReport(
  checked: readonly CheckedRecord[],
  notes: string,
): string {
  const records = checked.map(item => item.record)
  const missing = checked.filter(item => item.reason !== undefined).map(item => item.record.feature_id)
  const supported = records.filter(record => record.enabled).length
  const passed = missing.length === 0
  const lines = [
    `充分公开实体判定（A26.3）：${passed ? '通过' : '未通过'}（独立权利要求特征 ${String(records.length)} 项，已支持 ${String(supported)} 项）`,
  ]
  for (const item of checked) {
    const record = item.record
    const anchor = record.anchor === undefined
      ? `锚点 ${record.anchor_reason}`
      : `命中区间 ${String(record.anchor.start)}-${String(record.anchor.end)}`
    const body = `${record.embodiment_id === '' ? '未给出实施例' : record.embodiment_id}；${record.parameter_or_effect === '' ? '未给出参数或效果' : record.parameter_or_effect}；${anchor}`
    const reason = item.reason === undefined ? '' : `；原因：${item.reason}`
    lines.push(`- [${record.enabled ? '已支持' : '缺少支持'}] ${record.feature_id}「${record.feature}」：${body}${reason}`)
  }
  if (missing.length > 0) lines.push(`未覆盖的独立权利要求特征：${missing.join('、')}`)
  lines.push('说明：模型给出的每条摘录都由程序经原文锚点复核；摘录为空或未命中原文时，该特征按未充分公开处理。')
  if (notes !== '') lines.push(`模型说明：${notes}`)
  return lines.join('\n')
}

/**
 * 由同一返回值同时产生报告与判定。
 *
 * 这是 `EnablementResult` 的唯一构造路径：任何调用方都必须经过它，
 * 因此不存在“写了报告但没写判定”的组合。
 * @param features - 程序派生的独立权利要求特征。
 * @param modelRecords - 模型记录；必须与特征 ID 一一对应。
 * @param specification - 说明书原文。
 * @param notes - 模型判定说明；缺省为空串。
 * @returns 完整业务输出，或首个结构错误原因。
 */
function buildEnablementResult(
  features: readonly EnablementFeature[],
  modelRecords: readonly ModelRecord[],
  specification: string,
  notes: string,
): { ok: true; result: EnablementResult } | { ok: false; reason: string } {
  const featureIds = new Set(features.map(feature => feature.id))
  const byFeature = new Map<string, ModelRecord>()
  for (const record of modelRecords) {
    if (!featureIds.has(record.feature_id)) {
      return { ok: false, reason: `records 含未知 feature_id：${record.feature_id}` }
    }
    if (byFeature.has(record.feature_id)) {
      return { ok: false, reason: `records 的 feature_id 重复：${record.feature_id}` }
    }
    byFeature.set(record.feature_id, record)
  }

  const checked = features.map(feature => checkFeature(feature, byFeature.get(feature.id), specification))
  const records = checked.map(item => item.record)
  const missing = checked.filter(item => item.reason !== undefined).map(item => item.record.feature_id)
  const result: EnablementResult = {
    enablement_report: renderEnablementReport(checked, notes),
    enablement_passed: missing.length === 0,
    enablement_records: records,
    enablement_missing: missing,
  }
  return { ok: true, result }
}

/** enablement-report 执行器：派生特征、调用模型、复核锚点并一次产出报告与判定。 */
export class EnablementReportHandler implements StageHandler {
  readonly name = 'enablement-report'
  readonly category = 'gate' as const

  /**
   * 执行充分公开判定。
   * @param input - 阶段执行输入（state 携带说明书、权利要求与领域信息）。
   * @returns 完整的 `EnablementResult`，或降级片段。
   */
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const read = readQuoteStageContext(input.state, 'enablement-report', { temperature: 0.1, promptLimit: 12000 })
    if (!read.ok) return read.state
    const { temperature, promptLimit, claimsLimit, pfeLimit, specification, claims, pfe, domain } = read.context

    const features = deriveFeatures(claims)
    if (features.length === 0) {
      return degraded('enablement-report', '无法从 state.claims_draft 派生独立权利要求特征')
    }

    const missing = requireLlm(input.provider, 'enablement-report')
    if (missing) return missing

    const figureRefs = collectFigureRefs(input.state)
    const featureLines = features.map(feature => `${feature.id} ${feature.text}`).join('\n')

    const prompt = [
      '你是专利审查员，负责判断说明书是否满足专利法第26条第3款（充分公开，能够实现）。',
      '逐条核对下列独立权利要求特征，并在说明书中找到直接记载这些特征的实施例摘录。',
      '要求：',
      '- 每条记录只对应一个给定 feature_id，不得新增、改写或合并特征；',
      '- quote 必须逐字摘录说明书原文，不得改写、拼接或转述；',
      '- embodiment_id 写实施例标识，parameter_or_effect 写支撑该特征可实现的参数或技术效果；',
      '- 缺少实施例、参数或效果的，enabled 记 false；',
      '- 任一特征没有可支撑的实施例，整体判定为不满足充分公开。',
      domainGuidance(domain),
      '',
      '【独立权利要求特征】',
      dataBlock(featureLines),
      figureRefs.length > 0 ? `【附图标记】\n${dataBlock(figureRefs.join('、'))}` : '',
      ...sourceBlocks({
        pfe,
        pfeLimit,
        pfeHeading: 'PFIE 参考特征（仅供定位，判定以权利要求特征为准）',
        claims,
        claimsLimit,
        specification,
        promptLimit,
      }),
      '请严格输出 JSON：records 为逐特征记录数组（feature_id、quote、embodiment_id、parameter_or_effect、enabled），notes 为判定说明。',
    ].filter(line => line !== '').join('\n')

    const parsed = await requestRecords(
      input.provider,
      'enablement-report',
      prompt,
      ENABLEMENT_SCHEMA,
      temperature,
      input.signal,
      readModelRecord,
    )
    if (!parsed.ok) return parsed.state
    const built = buildEnablementResult(features, parsed.records, specification, parsed.notes)
    return built.ok ? built.result : degraded('enablement-report', built.reason)
  }
}
