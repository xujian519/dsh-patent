/**
 * claim-chart 原子：权利要求要素级证据网格构建。
 *
 * 流程：LLM 产出要素拆分 + 逐行映射 → element-validator / mapping-machine /
 * pin-cite-validator（源文可读时）三关校验 → 非法打回重做（≤2 次，重做
 * prompt 附校验错误清单）→ gap 检测 → caseId 可用时落盘 json+md。
 *
 * OA 答复（mode=oa-response）未手传 `chart_targets` 时，目标由解析产出（state 的
 * `office_action`）确定性派生：映射对象即审查员引用的对比文件，不再依赖调用方手工构造。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from '../../handler.ts'
import {
  DRAFT_NOTICE,
  MAPPINGS,
  type ChartMode,
  type ChartRow,
  type ChartTarget,
  type ClaimChart,
  type ClaimElement,
} from '../../../claim-chart/protocol/types.ts'
import { validateElements } from '../../../claim-chart/runtime/element-validator.ts'
import { deriveClaimRefs } from '../../../claim-chart/runtime/claim-refs.ts'
import { validateRowMapping } from '../../../claim-chart/runtime/mapping-machine.ts'
import { deriveInvalidityConclusion } from '../../../claim-chart/runtime/invalidity-conclusion.ts'
import { detectGaps } from '../../../claim-chart/runtime/gap-detector.ts'
import {
  validatePinCite,
  validatePinCiteFormat,
  verifyQuoteInSource,
  type PinCiteCheckResult,
} from '../../../claim-chart/runtime/pin-cite-validator.ts'
import { loadClaimChart, saveClaimChart } from '../../../claim-chart/runtime/store.ts'
import { asJsonRecord, readJsonString } from '../../../llm-json.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import { callLlm, degraded, parseLlmJson, requireLlm, resolveInputText } from './llm.ts'
import {
  readAtomTunables,
  readChartSourceMaxBytes,
  readChartSourceRoots,
} from '../../tunables.ts'
import {
  readChartSource,
  resolveChartSourcePolicy,
  type ChartSourcePolicy,
  type ChartSourceReadResult,
} from './chart-source.ts'

/** claim-chart 原子：权利要求要素级证据网格构建。 */
export const claimChartAtom: Atom = {
  name: 'claim-chart',
  description: '权利要求要素级证据网格：要素编号 + 逐要素映射 + pin-cite + gap 检测',
  category: 'compare',
  // office_action / prior_art 是 chart_targets 缺省时按模式派生目标的来源。
  inputSchema: ['claim', 'chart_targets', 'chart_mode', 'office_action', 'prior_art'],
  outputSchema: ['claim_chart_doc', 'gap_list', 'claim_chart_paths'],
  usesModel: true,
}

const CHART_MODES: readonly ChartMode[] = ['infringement', 'invalidity', 'oa-response', 'reexamination', 'patentability']

/** 类型守卫：值是否为已知的图表模式。 */
function isChartMode(value: string): value is ChartMode {
  return CHART_MODES.some(mode => mode === value)
}
const ELEMENT_KINDS: readonly string[] = [
  'preamble',
  'transitional',
  'limitation',
  'means-plus-function',
  'markush-member',
]

const CHART_SCHEMA = {
  type: 'object',
  properties: {
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要素编号，如 1a/1b（数字+小写字母）' },
          claimNo: { type: 'number', description: '权利要求序号' },
          text: { type: 'string', description: '要素原文（必须为权利要求原文的连续子串，逐字引用）' },
          kind: { type: 'string', enum: ELEMENT_KINDS },
        },
        required: ['id', 'claimNo', 'text', 'kind'],
      },
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          elementId: { type: 'string' },
          targetId: { type: 'string' },
          quote: { type: 'string', description: '目标对象对应内容的逐字引用（未找到时为空串）' },
          pinCite: { type: 'string', description: '位置引用，格式 [D1 段[0032] 图3]；目标未提供源文时留空串' },
          mapping: { type: 'string', enum: MAPPINGS },
        },
        required: ['elementId', 'targetId', 'quote', 'pinCite', 'mapping'],
      },
    },
  },
  required: ['elements', 'rows'],
} as const

const MAX_RETRIES = 2

type TargetsParseResult = { targets: ChartTarget[]; error: string | null }

/**
 * 解析目标对象列表：损坏 JSON / 非数组时给出可操作的错误（而非静默当空处理）。
 *
 * 字段归一化：外部输入契约（patent_workflow_run.chartTargets 文档）用
 * snake_case（source_path）与 kind=product；内核 ChartTarget 用 camelCase
 * （sourcePath）与 kind=accused-product。不归一化会让 sourcePath 恒为
 * undefined → pin-cite/引用校验静默跳过（fail-open），防幻觉引用失效。
 * 同时只产出 ChartTarget 形状（source_path 等冗余键不残留）。
 */
function parseTargets(raw: string): TargetsParseResult {
  if (raw.trim().length === 0) return { targets: [], error: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { targets: [], error: '输入 chart_targets 不是数组' }
    const targets: ChartTarget[] = []
    for (const [index, entry] of parsed.entries()) {
      const t = asJsonRecord(entry)
      if (t === undefined) return { targets: [], error: `chart_targets[${index}] 不是对象` }
      // id 是行映射的引用键（rows.targetId）；缺失或空串的目标无法被任何行引用，直接报错。
      const id = readJsonString(t.id)
      if (id === undefined) {
        return { targets: [], error: `chart_targets[${index}] 缺少 id（须为非空字符串）` }
      }
      // kind 归一化：外部契约用 product=被控产品；内核仅支持 prior-art/accused-product，
      // 未知 kind 直接报错（fail-closed），避免静默落入"被控产品"渲染与校验分支。
      const rawKind = t.kind === 'product' ? 'accused-product' : t.kind
      if (rawKind !== 'prior-art' && rawKind !== 'accused-product') {
        return { targets: [], error: `目标 ${JSON.stringify(id)} 的 kind 非法（仅支持 prior-art/product）: ${JSON.stringify(t.kind)}` }
      }
      let sourcePath: string | undefined
      if (typeof t.sourcePath === 'string') {
        sourcePath = t.sourcePath
      } else if (typeof t.source_path === 'string') {
        sourcePath = t.source_path
      }
      targets.push({
        id,
        kind: rawKind,
        ...(typeof t.title === 'string' ? { title: t.title } : {}),
        ...(sourcePath === undefined ? {} : { sourcePath }),
      })
    }
    return { targets, error: null }
  } catch {
    return { targets: [], error: '输入 chart_targets JSON 解析失败' }
  }
}

/**
 * 由通知书解析产出派生 claim-chart 目标：审查员引用的对比文件逐项成为 prior-art 目标。
 *
 * OA 答复的映射对象就是通知书引用的对比文件，来源即 parse 阶段的确定性产出；派生目标
 * 未提供文献正文（无 sourcePath），行内 quote/pinCite 留空串是既定的"未提供源文"语义。
 * 解析产出不可读、不是对象或没有引用文献时返回空列表，回落"只拆要素"语义——缺目标由
 * 上游解析质量承担，不在此兜底造目标。引用条目缺文献号时跳过该条（无法成为映射目标）。
 * @param officeActionJson - parse 阶段写入 state 的 `office_action` JSON。
 * @returns 对比文件目标列表（按解析顺序去重）；不可解析时为空列表。
 */
export function deriveOfficeActionTargets(officeActionJson: string): ChartTarget[] {
  if (officeActionJson.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(officeActionJson)
  } catch {
    return []
  }
  const notice = asJsonRecord(parsed)
  if (notice === undefined) return []
  const citations = notice.citations
  if (!Array.isArray(citations)) return []
  const targets: ChartTarget[] = []
  const seen = new Set<string>()
  for (const citation of citations) {
    const record = asJsonRecord(citation)
    if (record === undefined) continue
    const documentNumber = readJsonString(record.documentNumber)
    if (documentNumber === undefined || seen.has(documentNumber)) continue
    seen.add(documentNumber)
    targets.push({ id: documentNumber, kind: 'prior-art' })
  }
  return targets
}

/**
 * 可专利性模式未显式传 `chart_targets` 时，从过滤后的 `prior_art` 派生映射目标：
 * 检索命中就是 claim chart 的对比文件。`D<n>` 标号与过滤报告、证据台账一致；
 * 缺标号的条目按 1 基序号补 `D<n>`，同一标号只保留一个目标。
 * @param priorArt - `prior_art` 状态值（检索命中数组）。
 * @returns 去重后的对比文件目标；非数组输入返回空数组。
 */
function derivePriorArtTargets(priorArt: unknown): ChartTarget[] {
  if (!Array.isArray(priorArt)) return []
  const targets: ChartTarget[] = []
  const seen = new Set<string>()
  priorArt.forEach((entry, index) => {
    const record = asJsonRecord(entry)
    if (record === undefined) return
    const rawLabel = typeof record.dLabel === 'string' ? record.dLabel.trim() : ''
    const id = /^D\d+$/.test(rawLabel) ? rawLabel : `D${index + 1}`
    if (seen.has(id)) return
    seen.add(id)
    const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
    targets.push(rawTitle.length > 0 ? { id, kind: 'prior-art', title: rawTitle } : { id, kind: 'prior-art' })
  })
  return targets
}

/**
 * 字段级形状防御：LLM 输出 malformed（缺字段 / 类型错误 / null 项）时返回
 * 错误清单，让非法输出回到打回重做路径，而不是在校验器内 TypeError 崩溃
 * （element-validator 的 stripWhitespace、mapping-machine 的 mapping 访问等）。
 */
function checkChartShape(elements: unknown[], rows: unknown[]): string[] {
  const errors: string[] = []
  elements.forEach((el, i) => {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      errors.push(`要素[${i}] 不是对象`)
      return
    }
    const e = el as Record<string, unknown>
    if (typeof e.id !== 'string') errors.push(`要素[${i}] 缺少 id`)
    if (typeof e.claimNo !== 'number') errors.push(`要素[${i}] 缺少 claimNo`)
    if (typeof e.text !== 'string') errors.push(`要素[${i}] 缺少 text`)
    if (typeof e.kind !== 'string') errors.push(`要素[${i}] 缺少 kind`)
  })
  rows.forEach((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`行[${i}] 不是对象`)
      return
    }
    const r = row as Record<string, unknown>
    if (typeof r.elementId !== 'string') errors.push(`行[${i}] 缺少 elementId`)
    if (typeof r.targetId !== 'string') errors.push(`行[${i}] 缺少 targetId`)
    if (typeof r.quote !== 'string') errors.push(`行[${i}] 缺少 quote`)
    if (typeof r.pinCite !== 'string') errors.push(`行[${i}] 缺少 pinCite`)
    if (typeof r.mapping !== 'string') errors.push(`行[${i}] 缺少 mapping`)
  })
  return errors
}

/**
 * 三关校验：返回错误列表（空 = 全部通过）。sources 由 execute 预读一次并在重做
 * attempt 间复用；声明了 sourcePath 的目标携带文本或失败原因，失败统一报"源文件不可读"。
 */
function validateChart(
  elements: ClaimElement[],
  rows: ChartRow[],
  sources: readonly SourcedTarget[],
  mode: ChartMode,
  claim: string,
): string[] {
  const errors: string[] = []
  errors.push(...checkChartShape(elements, rows))
  if (errors.length > 0) return errors // 形状非法：跳过语义校验（避免二次崩溃），回到打回重做
  const elResult = validateElements(elements, claim)
  if (!elResult.ok) errors.push(...elResult.errors)
  const elementById = new Map(elements.map(el => [el.id, el]))
  const targetById = new Map(sources.map(entry => [entry.target.id, entry]))
  // 目标存在性仅在有目标对象时核验（"只拆要素"模式 targets 为空，无目标可对照，放行）。
  const targetsProvided = sources.length > 0
  if (!targetsProvided && rows.length > 0) {
    // 元素模式：schema 强制 rows 数组但无目标可映射，LLM 产出的 targetId 无对应目标
    // （幻影引用）不得进入 chart 与 gap 推导，打回重做（prompt 已要求输出空数组）。
    errors.push('无目标对象（chart_targets 为空）时不得产出映射行，rows 必须为空数组')
  }
  for (const row of rows) {
    // 引用完整性：LLM 幻觉出的未知 elementId/targetId 不得静默进入渲染与 gap
    // 推导（归入打回重做路径）。
    if (!elementById.has(row.elementId)) {
      errors.push(`行 [${row.elementId}→${row.targetId}] 引用了不存在的要素 ${row.elementId}`)
    }
    if (targetsProvided && !targetById.has(row.targetId)) {
      errors.push(`行 [${row.elementId}→${row.targetId}] 引用了不存在的目标 ${row.targetId}`)
    }
    // pin-cite 格式校验无条件执行（纯函数，不依赖源文；防幻觉引用最便宜的防线，
    // 多数用户不传 source_path，段号/quote 校验仅在源文可读时追加）。
    // 空 pinCite（trim 后为空）放行：与 quote 空串语义对齐，代表"未提供位置定位"。
    const pinFormat: PinCiteCheckResult =
      row.pinCite.trim().length > 0 ? validatePinCiteFormat(row.pinCite) : { ok: true }
    if (!pinFormat.ok) errors.push(`行 [${row.elementId}→${row.targetId}] ${pinFormat.reason}`)
    const target = targetById.get(row.targetId)
    errors.push(...validateRowMapping(row, target?.target, mode))
    if (target?.source !== undefined) {
      const { path, result } = target.source
      if (!result.ok) {
        errors.push(`行 [${row.elementId}→${row.targetId}] 源文件不可读: ${path}（${result.reason}）`)
        continue
      }
      const sourceText = result.text
      const pin = validatePinCite(row.pinCite, sourceText)
      if (!pin.ok) errors.push(`行 [${row.elementId}→${row.targetId}] ${pin.reason}`)
      const quote = verifyQuoteInSource(row.quote, sourceText)
      if (!quote.ok) errors.push(`行 [${row.elementId}→${row.targetId}] ${quote.reason}`)
    }
  }
  return errors
}

/** 目标及其源文读取结果；仅在目标声明 sourcePath 时携带 source。 */
type SourcedTarget = {
  target: ChartTarget
  source?: {
    /** 目标声明的路径，用于行级错误归因。 */
    path: string
    /** 预读成功返回文本，失败返回原因。 */
    result: ChartSourceReadResult
  }
}

/** 未显式提供目标时，按场景模式从上一阶段产出派生。 */
function deriveModeTargets(mode: ChartMode, state: PipelineState): ChartTarget[] {
  if (mode === 'oa-response') return deriveOfficeActionTargets(getStateString(state, 'office_action'))
  if (mode === 'patentability') return derivePriorArtTargets(state['prior_art'])
  return []
}

/**
 * 预读目标源文件一次（重做 attempt 间复用）：同一路径只读一次，不同路径并行读取。
 * 失败结果同样随目标返回，由 validateChart 对引用该源的每行报出具体原因。
 */
async function readTargetSources(
  targets: readonly ChartTarget[],
  policy: ChartSourcePolicy,
): Promise<SourcedTarget[]> {
  const reads = new Map<string, Promise<ChartSourceReadResult>>()
  return Promise.all(targets.map(async (target) => {
    if (target.sourcePath === undefined) return { target }
    let read = reads.get(target.sourcePath)
    if (read === undefined) {
      read = readChartSource(target.sourcePath, policy)
      reads.set(target.sourcePath, read)
    }
    return { target, source: { path: target.sourcePath, result: await read } }
  }))
}

/** 渲染提示词中的目标清单。 */
function renderTargetLines(targets: readonly ChartTarget[]): string {
  if (targets.length === 0) return '（无目标对象 —— 只拆分要素，逐行映射留待后续补充）'
  return targets
    .map(
      target =>
        `- ${target.id}（${target.kind === 'prior-art' ? '对比文件' : '被控产品'}${
          target.title ? `：${target.title}` : ''
        }${target.sourcePath === undefined ? '，未提供源文' : ''}）`,
    )
    .join('\n')
}

/** claim-chart 执行器：构建权利要求要素级证据网格。 */
export class ClaimChartHandler implements StageHandler {
  readonly name = 'claim-chart'
  readonly category = 'compare' as const

  /**
   * 执行 claim-chart 阶段，返回下一管线状态。
   * @param input - 阶段执行输入（state 与 LLM provider）。
   * @returns 下一管线状态（可能带降级标记）。
   */
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state, provider, signal } = input
    const tuned = readAtomTunables(state, {
      temperature: 0.1,
      promptLimit: 8000,
      maxRetries: MAX_RETRIES,
    })
    if (!tuned.ok) return degraded('claim-chart', tuned.reason)
    const { temperature, promptLimit, maxRetries } = tuned.tunables
    const rootsResult = readChartSourceRoots(state)
    if (!rootsResult.ok) return degraded('claim-chart', rootsResult.reason)
    const sourceMaxBytes = readChartSourceMaxBytes(state)
    if (!sourceMaxBytes.ok) return degraded('claim-chart', sourceMaxBytes.reason)
    const policyResult = await resolveChartSourcePolicy(
      rootsResult.roots,
      sourceMaxBytes.value,
      process.cwd(),
    )
    if (!policyResult.ok) return degraded('claim-chart', policyResult.reason)
    const missing = requireLlm(provider, 'claim-chart')
    if (missing) return missing
    const claim = resolveInputText(state, ['claim', 'claim_text'], '')
    if (claim.trim().length === 0) {
      return degraded('claim-chart', '权利要求为空')
    }
    // 缺省/空白 chart_mode 沿用 invalidity；显式给出的非法值降级，不静默换模式
    // （静默回退会让调用方的侵权/可专利性输入按无效模式产出结论）。
    const modeRaw = getStateString(state, 'chart_mode').trim()
    if (modeRaw !== '' && !isChartMode(modeRaw)) {
      return degraded(
        'claim-chart',
        `chart_mode 非法: ${JSON.stringify(modeRaw)}（须为 ${CHART_MODES.join(' / ')}）`,
      )
    }
    const mode: ChartMode = modeRaw === '' ? 'invalidity' : modeRaw
    const targetsRes = parseTargets(getStateString(state, 'chart_targets'))
    if (targetsRes.error) return degraded('claim-chart', targetsRes.error)
    // 显式传入的目标优先；OA 答复由解析产出派生，可专利性由过滤后的检索命中派生。
    const targets = targetsRes.targets.length > 0 ? targetsRes.targets : deriveModeTargets(mode, state)

    const sources = await readTargetSources(targets, policyResult.policy)
    const targetLines = renderTargetLines(targets)
    const basePrompt = [
      '你是专利权利要求分析专家。把权利要求拆分为编号要素，并逐要素映射到目标对象。',
      '',
      '【权利要求】',
      dataBlock(claim.slice(0, promptLimit)),
      '',
      '【目标对象】',
      dataBlock(targetLines),
      '',
      '要求：',
      '- 要素拆分到最小技术单元（单一技术手段、单一技术效果、可独立比对），可再拆分的必须拆开',
      '- 每个要素四个字段齐全：id、claimNo、text、kind',
      '- id 为 所属权利要求序号 + 小写字母（1a/1b/1c…、2a/2b…）：同一权利要求内从 a 起连续、不跳号，claimNo 与该数字前缀一致',
      '- kind 取 preamble（主题名称）/transitional（过渡词）/limitation（技术特征）/means-plus-function（功能性限定）/markush-member（马库什要素）',
      '- 方法权利要求注意各步骤的逻辑顺序与执行主体；结构权利要求注意部件的连接关系与空间位置',
      '- 要素 text 必须为所属权利要求原文的连续子串（逐字引用，不得改写）',
      '- 每个要素对每个目标产出一行，五个字段齐全：elementId、targetId、quote、pinCite、mapping',
      '- quote 为目标对象对应内容的逐字引用（未找到/证据不足时为空串）',
      '- 无目标对象（【目标对象】为空）时只输出 elements，rows 必须为空数组 []',
      '- pinCite 格式 [D1 段[0032] 图3]；标注"未提供源文"的目标没有段落编号可引，针对这类目标的 quote 与 pinCite 一律留空串（不得拿标题或自造段号充数）；mapping 取值：literal（字面对应）/literal-construction-dependent/doe（等同，仅侵权）/anticipation（单篇公开，仅对比文件）/obviousness-combination（组合公开，仅对比文件）/partial/not-found/needs-evidence/construction-dependent',
      `- 场景模式：${mode}`,
      '',
      '请严格输出 JSON。',
    ].join('\n')

    let prompt = basePrompt
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const res = await callLlm(
        provider,
        'claim-chart',
        prompt,
        { schema: CHART_SCHEMA, temperature },
        signal,
      )
      if (!res.ok) return res.error
      const parsed = parseLlmJson(
        res.raw,
        (obj, raw) => {
          if (!Array.isArray(obj.elements) || !Array.isArray(obj.rows)) return null
          return { elements: obj.elements as ClaimElement[], rows: obj.rows as ChartRow[], raw }
        },
        raw => ({ elements: [], rows: [], raw }),
      )
      const elements = parsed.elements as ClaimElement[]
      const rows = parsed.rows as ChartRow[]
      const errors = validateChart(elements, rows, sources, mode, claim)
      if (errors.length === 0) {
        const gaps = detectGaps(rows, elements, targets)
        // 落盘/核验按 mode 区分 chartId：同一 caseId 下不同场景（invalidity /
        // patentability / oa-response…）互不覆盖，verified 标记也不跨 mode 串扰。
        const chartId = `chart-${mode}`
        const existing = provider?.caseId ? loadClaimChart(provider.caseId, chartId) : null
        // HITL 核验标记只迁移到内容完全一致的行（mapping/quote/pinCite 指纹）：
        // 重跑产出变化后旧核验作废，不得静默迁移到未复核的新内容上。
        const verifiedByContent = new Map(
          (existing?.rows ?? [])
            .filter(r => r.verified)
            .map(r => [`${r.elementId}→${r.targetId}|${r.mapping}|${r.quote}|${r.pinCite}`, true]),
        )
        for (const row of rows) {
          row.state = row.mapping
          row.verified = verifiedByContent.has(
            `${row.elementId}→${row.targetId}|${row.mapping}|${row.quote}|${row.pinCite}`,
          )
        }
        const chart: ClaimChart = {
          chartId,
          mode,
          caseId: provider?.caseId ?? '',
          elements,
          claimNos: [...new Set(elements.map(el => el.claimNo))].sort((a, b) => a - b),
          // 引用关系由权利要求原文推出（不由模型填报）：从属权项的比对对象是所引用权项的
          // 全部技术特征与附加技术特征的组合，覆盖判定要用它。
          claims: deriveClaimRefs(claim),
          targets,
          rows,
          gaps,
          draftNotice: DRAFT_NOTICE,
        }
        // 无效与复审另出确定性结论并随图表落盘：单篇全覆盖是"单篇对比文件是否公开权利要求
        // 全部技术特征"的直接答案，由行级映射算出，不收模型给的结论（口径归
        // invalidity-conclusion.ts）。结论作为图表的派生字段而不是独立阶段，见协议层注解。
        if (mode === 'invalidity' || mode === 'reexamination') {
          chart.invalidityConclusion = deriveInvalidityConclusion(chart)
        }
        const state: PipelineState = {
          claim_chart_doc: JSON.stringify(chart, null, 2),
          gap_list: JSON.stringify(chart.gaps),
        }
        // 落盘路径透出：saveClaimChart 返回 { jsonPath, mdPath }，供工具层
        // 透传给用户（无 caseId 时不写该键，避免空路径噪音）。
        if (provider?.caseId) {
          state.claim_chart_paths = JSON.stringify(await saveClaimChart(chart, provider.caseId))
        }
        return state
      }
      if (attempt >= maxRetries) {
        return degraded(
          'claim-chart',
          `校验失败且重做超限（${maxRetries} 次）: ${errors.slice(0, 5).join('；')}`,
        )
      }
      prompt = `${basePrompt}\n\n【上一轮输出校验失败，请修正后重新输出】\n${errors.map(e => `- ${e}`).join('\n')}`
    }
    // 理论上不可达（循环内每个 attempt 均已 return），保留作防御性兜底
    return degraded('claim-chart', '重做循环异常退出')
  }
}
