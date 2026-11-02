/**
 * 撰写域原子：draft-review（撰写链换位审查）。
 *
 * 写完权利要求与说明书后，由「审查员」立刻挡一轮：只从说明书、权利要求、
 * PFIE 特征与检索文献出发，输出按 26.3 / 26.4 / 清楚性 / 单一性 / 33 条分类的
 * 争议点与可执行建议。争议点经原文锚点复核后同时产出报告与判定，并按类别发出
 * 结构化回退信号，由 manifest 的 `retry.routes` 路由回相应的上游阶段。
 *
 * 隔离：`inputSchema` 与执行器只读白名单键；策略表、融合结果与从权改写记录
 * 都不进入提示词。锚点未命中、类别或建议越界时阶段失败，不降级成空报告。
 */

import { readJsonString, tryParseJson } from '../../../llm-json.ts'
import { type Atom } from '../../atom.ts'
import {
  REVISION_SIGNALS_KEY,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
} from '../../handler.ts'
import { readAtomTunables } from '../../tunables.ts'
import {
  DRAFT_REVIEW_ALLOWED_KEYS,
  DRAFT_REVIEW_FORBIDDEN_KEYS,
  buildCheckedDisputes,
  buildDraftReviewPrompt,
  buildDraftReviewResult,
  checkDraftReviewInput,
  draftReviewRevisionSignals,
  readModelDispute,
  scanDraftReviewOutput,
  type DraftReviewInput,
  type ModelDispute,
  DRAFT_REVIEW_SCHEMA,
} from '../../../draft-review/index.ts'
import { callLlm, degraded, formatPriorArt, requireLlm } from './llm.ts'
import { readStateText } from './state-keys.ts'

/** draft-review 原子：撰写链的换位审查与回退路由。 */
export const draftReviewAtom: Atom = {
  name: 'draft-review',
  description:
    '撰写链换位审查：只读说明书、权利要求、PFIE 特征与检索文献，按 26.3/26.4/清楚性/单一性/33 条列出争议点并复核原文锚点，可执行争议点按类别发出回退信号',
  category: 'gate',
  usesModel: true,
  logInputScope: true,
  inputSchema: [...DRAFT_REVIEW_ALLOWED_KEYS],
  outputSchema: ['draft_review_report', 'draft_review_disputes', 'draft_review_passed'],
}

/** 输入读取结果：成功携带白名单输入，失败携带降级片段。 */
type DraftReviewInputRead =
  | { ok: true; input: DraftReviewInput }
  | { ok: false; state: PipelineState }

/** 读取审查输入；只复制白名单键，禁用键由 {@link checkDraftReviewInput} 兜底拒绝。 */
function readDraftReviewInput(state: PipelineState): DraftReviewInputRead {
  const specification = readStateText(state, 'specification')
  if (specification === undefined) {
    return { ok: false, state: degraded('draft-review', '输入为空（state.specification 缺失）') }
  }
  const claims = readStateText(state, 'claims_draft')
  if (claims === undefined) {
    return { ok: false, state: degraded('draft-review', '输入为空（state.claims_draft 缺失）') }
  }

  const pfeTriples = getStateArray(state, 'pfe_triples')
  const features = getStateArray(state, 'features')
  const pfe = pfeTriples.length > 0
    ? JSON.stringify(pfeTriples)
    : features.length > 0 ? JSON.stringify(features) : ''
  const priorArt = getStateArray(state, 'prior_art').length > 0 ? formatPriorArt(state) : ''

  const bundle: Record<string, unknown> = { specification, claims_draft: claims }
  if (pfe !== '') bundle['pfe'] = pfe
  if (priorArt !== '') bundle['prior_art'] = priorArt
  const isolation = checkDraftReviewInput(bundle)
  /* v8 ignore next 5 -- bundle 只复制白名单键，禁用键在构造上不可达；checkDraftReviewInput 的拒绝路径由契约用例覆盖 */
  if (!isolation.clean) {
    return {
      ok: false,
      state: degraded('draft-review', `输入隔离失败：检测到禁用键 ${isolation.leakedKeys.join('、')}`),
    }
  }
  return { ok: true, input: { specification, claims, pfe, priorArt } }
}

/** 模型争议点解析结果。 */
type DisputesRead =
  | { ok: true; disputes: ModelDispute[]; notes: string }
  | { ok: false; reason: string }

/** 解析模型输出；任一争议点形状不符即返回可读原因。 */
function readDisputes(parsed: Record<string, unknown>): DisputesRead {
  const raw = parsed['disputes']
  if (!Array.isArray(raw)) return { ok: false, reason: '模型输出的 disputes 不是数组' }
  const disputes: ModelDispute[] = []
  for (const [index, item] of raw.entries()) {
    const read = readModelDispute(item, index)
    if (!read.ok) return read
    disputes.push(read.dispute)
  }
  const notes = readJsonString(parsed['notes']) ?? ''
  return { ok: true, disputes, notes }
}

/** draft-review 执行器：审查、复核锚点、一次产出报告与判定，并按类别发出回退信号。 */
export class DraftReviewHandler implements StageHandler {
  readonly name = 'draft-review'
  readonly category = 'gate' as const

  /**
   * 执行撰写链换位审查。
   * @param input - 阶段执行输入（state 携带说明书、权利要求、PFIE 特征与检索文献）。
   * @returns 报告、争议点、判定与结构化回退信号，或降级片段。
   */
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const declaredLeaks = DRAFT_REVIEW_FORBIDDEN_KEYS.filter(key => draftReviewAtom.inputSchema.includes(key))
    /* v8 ignore next 3 -- 防御未来的白名单编辑：inputSchema 由常量构造，契约用例已断言它不含禁用键 */
    if (declaredLeaks.length > 0) {
      return degraded('draft-review', `输入隔离失败：inputSchema 含禁用键 ${declaredLeaks.join('、')}`)
    }

    const read = readDraftReviewInput(input.state)
    if (!read.ok) return read.state

    const tuned = readAtomTunables(input.state, { temperature: 0.1, promptLimit: 12000 })
    if (!tuned.ok) return degraded('draft-review', tuned.reason)
    const { temperature, promptLimit, promptLimitConfigured } = tuned.tunables

    const missing = requireLlm(input.provider, 'draft-review')
    if (missing) return missing

    const prompt = buildDraftReviewPrompt(read.input, {
      specificationLimit: promptLimit,
      claimsLimit: promptLimitConfigured ? promptLimit : 3000,
      pfeLimit: promptLimitConfigured ? promptLimit : 2000,
      priorArtLimit: promptLimitConfigured ? promptLimit : 2000,
    }, input.provider)

    const called = await callLlm(input.provider, 'draft-review', prompt, {
      schema: DRAFT_REVIEW_SCHEMA,
      temperature,
    }, input.signal)
    if (!called.ok) return called.error

    const parsed = tryParseJson(called.raw)
    if (parsed === undefined) return degraded('draft-review', '模型输出不是 JSON 对象')
    const disputes = readDisputes(parsed)
    if (!disputes.ok) return degraded('draft-review', disputes.reason)
    const outputLeak = scanDraftReviewOutput(disputes.notes)
    if (!outputLeak.clean) {
      return degraded(
        'draft-review',
        `输出隔离失败：审查说明含禁用术语 ${outputLeak.leakedKeys.join('、')}`,
      )
    }

    const built = buildCheckedDisputes(disputes.disputes, read.input)
    if (!built.ok) return degraded('draft-review', built.reason)

    const result = buildDraftReviewResult(built.disputes, disputes.notes)
    const signals = draftReviewRevisionSignals(result.draft_review_disputes)
    return {
      ...result,
      ...(signals.length > 0 ? { [REVISION_SIGNALS_KEY]: signals } : {}),
    }
  }
}
