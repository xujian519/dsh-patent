/**
 * 说明书摘录判定的共享阶段辅助。
 *
 * `enablement-report` 与 `claim-breadth` 使用同一段输入与模型解析流程：读取说明书、
 * 权利要求与 PFIE 参考，拼出原文块，调用模型后严格解析 `records` 与 `notes`。
 * 本模块收敛这段流程，两个 handler 只保留各自的派生、校验与报告构造。
 */

import { parseJsonRecordArray, tryParseJson } from '../../../llm-json.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import type { StageProvider } from '../../../types.ts'
import { type PipelineState, getStateArray, getStateString } from '../../handler.ts'
import { readAtomTunables } from '../../tunables.ts'
import { callLlm, degraded } from './llm.ts'
import { readStateText } from './state-keys.ts'

/** 一次判定阶段共享的输入与提示词预算。 */
export type QuoteStageContext = {
  /** 模型采样温度。 */
  temperature: number
  /** 说明书正文的截断上限。 */
  promptLimit: number
  /** 权利要求草稿的截断上限。 */
  claimsLimit: number
  /** PFIE 参考特征的截断上限。 */
  pfeLimit: number
  /** 说明书原文。 */
  specification: string
  /** 权利要求草稿原文。 */
  claims: string
  /** PFIE 参考特征文本；三处来源都为空时为空串。 */
  pfe: string
  /** `state.tech_domain`；缺失时为空串。 */
  domain: string
}

/** 共享上下文的读取结果。 */
export type QuoteStageRead =
  | { ok: true; context: QuoteStageContext }
  | { ok: false; state: PipelineState }

/**
 * 读取说明书、权利要求、PFIE 参考与提示词预算。
 * @param state - 状态容器。
 * @param atom - 原子名称，用于降级诊断。
 * @param defaults - 未配置 tunables 时的温度与提示词上限。
 * @returns 共享上下文，或首个输入缺失的降级片段。
 */
export function readQuoteStageContext(
  state: PipelineState,
  atom: string,
  defaults: { temperature: number; promptLimit: number },
): QuoteStageRead {
  const tuned = readAtomTunables(state, defaults)
  if (!tuned.ok) return { ok: false, state: degraded(atom, tuned.reason) }
  const { temperature, promptLimit, promptLimitConfigured } = tuned.tunables

  const specification = readStateText(state, 'specification')
  if (specification === undefined) {
    return { ok: false, state: degraded(atom, '输入为空（state.specification 缺失）') }
  }
  const claims = readStateText(state, 'claims_draft')
  if (claims === undefined) {
    return { ok: false, state: degraded(atom, '输入为空（state.claims_draft 缺失）') }
  }

  const pfeTriples = getStateArray(state, 'pfe_triples')
  const pfeFeatures = getStateArray(state, 'features')
  const pfe = pfeTriples.length > 0
    ? JSON.stringify(pfeTriples)
    : pfeFeatures.length > 0
      ? JSON.stringify(pfeFeatures)
      : getStateString(state, 'merge_result')
  return {
    ok: true,
    context: {
      temperature,
      promptLimit,
      claimsLimit: promptLimitConfigured ? promptLimit : 3000,
      pfeLimit: promptLimitConfigured ? promptLimit : 2000,
      specification,
      claims,
      pfe,
      domain: getStateString(state, 'tech_domain'),
    },
  }
}

/** 原文块的内容与截断上限。 */
type SourceBlocksInput = {
  /** PFIE 参考特征文本。 */
  pfe: string
  /** PFIE 参考特征的截断上限。 */
  pfeLimit: number
  /** PFIE 块的标题；各原子按自己的判定口径书写。 */
  pfeHeading: string
  /** 权利要求草稿原文。 */
  claims: string
  /** 权利要求草稿的截断上限。 */
  claimsLimit: number
  /** 说明书原文。 */
  specification: string
  /** 说明书的截断上限。 */
  promptLimit: number
}

/**
 * 拼出 PFIE 参考、权利要求与说明书原文块。
 * @param input - 原文与各自的截断上限。
 * @returns 可展开进提示词的行数组；PFIE 参考为空时省略该块。
 */
export function sourceBlocks(input: SourceBlocksInput): string[] {
  return [
    input.pfe.trim().length > 0 ? `【${input.pfeHeading}】\n${dataBlock(input.pfe.slice(0, input.pfeLimit))}` : '',
    '',
    '【权利要求草稿】',
    dataBlock(input.claims.slice(0, input.claimsLimit)),
    '',
    '【说明书】',
    dataBlock(input.specification.slice(0, input.promptLimit)),
    '',
  ]
}

/** 模型记录解析结果。 */
export type RecordRequest<T> =
  | { ok: true; records: T[]; notes: string }
  | { ok: false; state: PipelineState }

/**
 * 调用模型并解析 `records` 与 `notes`。
 * @param provider - 阶段能力提供者。
 * @param atom - 原子名称，用于降级诊断。
 * @param prompt - 完整提示词。
 * @param schema - 模型输出 JSON Schema。
 * @param temperature - 采样温度。
 * @param signal - 调用方取消信号。
 * @param readRecord - 单条记录的严格解析器；返回字符串表示该记录不合法。
 * @returns 解析后的记录与说明，或降级片段。
 */
export async function requestRecords<T>(
  provider: StageProvider | undefined,
  atom: string,
  prompt: string,
  schema: unknown,
  temperature: number,
  signal: AbortSignal | undefined,
  readRecord: (record: Record<string, unknown>, index: number) => T | string,
): Promise<RecordRequest<T>> {
  const res = await callLlm(provider, atom, prompt, { schema, temperature }, signal)
  if (!res.ok) return { ok: false, state: res.error }
  const parsed = tryParseJson(res.raw)
  if (parsed === undefined) return { ok: false, state: degraded(atom, '模型输出不是 JSON 对象') }
  const parsedRecords = parseJsonRecordArray(parsed['records'], 'records')
  if (!parsedRecords.ok) return { ok: false, state: degraded(atom, parsedRecords.reason) }
  const records: T[] = []
  for (const [index, record] of parsedRecords.values.entries()) {
    const read = readRecord(record, index)
    if (typeof read === 'string') return { ok: false, state: degraded(atom, read) }
    records.push(read)
  }
  const notesValue = parsed['notes']
  if (notesValue !== undefined && typeof notesValue !== 'string') {
    return { ok: false, state: degraded(atom, 'notes 不是字符串') }
  }
  return { ok: true, records, notes: typeof notesValue === 'string' ? notesValue.trim() : '' }
}
