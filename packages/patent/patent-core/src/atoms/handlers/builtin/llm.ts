/**
 * src/patent/atoms/handlers/builtin — LLM 阶段公共骨架。
 *
 * 收敛 7 个 LLM handler（extract/compare/reasoning/groundedness/keywords/novelty/
 * draft-claims）的重复模式：provider 检查、try/catch 调用、JSON 解析兜底。
 * 各 handler 仅需声明输入读取、prompt 构造与输出转换三要素。
 */

import { isAbortError } from '@deepseek-ai/dsh-value'
import type { PipelineState } from '../../handler.ts'
import {
  DEGRADED_CODE_KEY,
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  StageCancelledError,
  getStateArray,
  getStateString,
  isStageCancelledError,
  type DegradedCode,
} from '../../handler.ts'
import type { StageProvider } from '../../../types.ts'
import { collectPortText } from '../../../model-port.ts'
import { tryParseJson } from '../../../llm-json.ts'

/**
 * 降级选项：`retryable` 标记 LLM/检索等临时故障，供执行器重试；
 * `code` 标记失败归属，供工具层选择稳定错误码。
 */
export type DegradedOptions = {
  /** `true` 表示失败可重试；缺省为终态失败。 */
  retryable?: boolean
  /** 失败归属；缺省按执行失败上报。 */
  code?: DegradedCode
}

/**
 * 返回包含降级诊断的状态片段。
 * @param atom - 发生降级的原子名称。
 * @param reason - 降级原因。
 * @param options - 可选重试标记与失败归属；终态执行失败省略。
 * @returns 携带 {@link DEGRADED_ERROR_KEY} 的状态片段，可重试时另带
 *   {@link DEGRADED_RETRYABLE_KEY}，声明归属时另带 {@link DEGRADED_CODE_KEY}。
 */
export function degraded(atom: string, reason: string, options: DegradedOptions = {}): PipelineState {
  return {
    [DEGRADED_ERROR_KEY]: `[${atom}] ${reason}`,
    ...(options.retryable === true ? { [DEGRADED_RETRYABLE_KEY]: true } : {}),
    ...(options.code === undefined ? {} : { [DEGRADED_CODE_KEY]: options.code }),
  }
}

/**
 * 提取状态文本：优先显式键，其次按 keywordsKey，最后返回空串。
 * @param state - 状态容器。
 * @param explicitKeys - 优先读取的显式键列表。
 * @param keywordsKey - 兜底读取的关键词键。
 * @returns 提取到的文本，无匹配时返回空串。
 */
export function resolveInputText(state: PipelineState, explicitKeys: string[], keywordsKey: string): string {
  for (const key of explicitKeys) {
    const v = getStateString(state, key)
    if (v.trim().length > 0) return v
  }
  return getStateString(state, keywordsKey).trim()
}

/** 现有技术文档形状（与 StageProvider.search 返回一致）。 */
type PriorArtDoc = { title?: string; snippet?: string; url?: string }

/** 类型守卫：仅保留对象元素（集中 prior_art 外部数据形状的 cast 边界）。 */
function isPriorArtDoc(doc: unknown): doc is PriorArtDoc {
  return doc !== null && typeof doc === 'object' && !Array.isArray(doc)
}

/** 读取 state.prior_art（unknown[]）并收窄为 PriorArtDoc[]（过滤非法元素）。 */
function readPriorArt(state: PipelineState): PriorArtDoc[] {
  return getStateArray(state, 'prior_art').filter(isPriorArtDoc)
}

/**
 * 把 prior_art 数组格式化为可读文本（compare/novelty 输入用）。
 * @param state - 状态容器。
 * @returns 格式化的现有技术文本。
 */
export function formatPriorArt(state: PipelineState): string {
  const docs = readPriorArt(state)
  if (docs.length === 0) return '(无现有技术)'
  return docs
    .map((d, i) => `[${i + 1}] ${d.title ?? '未命名'}${d.url ? ` (${d.url})` : ''}\n${d.snippet ?? ''}`)
    .join('\n\n')
}

/** 有效 LLM 调用函数：优先 provider.callLLM（测试注入/字符串接缝），否则经 provider.llm（ModelPort）桥接。 */
function resolveLlmCall(
  provider: StageProvider | undefined,
  signal?: AbortSignal,
): ((prompt: string, opts?: { jsonSchema?: unknown; temperature?: number }) => Promise<string>) | undefined {
  if (provider?.callLLM) {
    const callLLM = provider.callLLM
    // 字符串接缝的 signal 是第三个参数；直接返回 provider.callLLM 会丢掉它。
    return async (prompt, opts) => callLLM(prompt, opts, signal)
  }
  if (provider?.llm) {
    const port = provider.llm
    // 端口桥接：逐调用 temperature/schema 经 PatentModelRequest 传递，
    // 取消信号透传到 port.stream（GenerateOptions.signal）。
    return async (prompt, opts) =>
      collectPortText(port, prompt, signal, {
        /* v8 ignore next -- every builtin handler passes temperature explicitly */
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts?.jsonSchema !== undefined ? { schema: opts.jsonSchema } : {}),
      })
  }
  return undefined
}

/**
 * provider 缺失检查：返回 null 表示可用，否则返回降级片段（调用方直接 return）。
 * @param provider - 能力提供者，可为 undefined。
 * @param atom - 原子名称。
 * @returns 可用时返回 null，否则返回降级片段。
 */
export function requireLlm(provider: StageProvider | undefined, atom: string): PipelineState | null {
  return resolveLlmCall(provider) ? null : degraded(atom, '未配置 LLM（provider.callLLM / provider.llm 缺失）')
}

/** LLM 调用结果：成功携带原始文本，失败携带降级片段与错误消息。 */
export type LlmCallResult = { ok: true; raw: string } | { ok: false; error: PipelineState; message: string }

/**
 * 读取取消状态。独立函数：`aborted` 是 readonly 属性，TypeScript 会把入口检查
 * 之后的值收窄为“未中止”，而信号可以在 `await` 期间中止。
 * @param signal - 调用方取消信号。
 * @returns 信号是否已中止。
 */
export function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * LLM 调用（统一降级）：成功返回 { ok, raw }，失败返回降级片段与错误消息。
 * @param provider - 能力提供者。
 * @param atom - 原子名称（用于降级标记）。
 * @param prompt - 提示词。
 * @param opts - 可选 schema 与 temperature。
 * @param signal - 调用方取消信号（透传给端口流）。
 * @returns LLM 调用结果。
 */
export async function callLlm(
  provider: StageProvider | undefined,
  atom: string,
  prompt: string,
  opts: { schema?: unknown; temperature?: number } = {},
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  // 已取消的调用不再发起模型请求：取消是控制流，不是可重试的阶段失败。
  if (isSignalAborted(signal)) throw new StageCancelledError(atom)
  const call = resolveLlmCall(provider, signal)
  /* v8 ignore next 2 -- requireLlm front-loads the identical resolveLlmCall check */
  if (!call) {
    return { ok: false, error: degraded(atom, '未配置 LLM（provider.callLLM / provider.llm 缺失）'), message: '未配置 LLM' }
  }
  try {
    const raw = await call(prompt, {
      ...(opts.schema !== undefined ? { jsonSchema: opts.schema } : {}),
      /* v8 ignore next -- every builtin handler passes temperature explicitly */
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })
    return { ok: true, raw }
  } catch (err) {
    // 取消以类型化错误穿透执行器与图引擎：不重试、不降级。
    if (isStageCancelledError(err)) throw err
    if (isSignalAborted(signal) || isAbortError(err)) throw new StageCancelledError(atom)
    // 配置类错误（fail-loud LLM stub 的 setup_required）向上传播，不得降级为阶段错误。
    if (err instanceof Error && (err as { code?: unknown }).code === 'setup_required') throw err
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: degraded(atom, `LLM 调用失败: ${message}`, { retryable: true }),
      message,
    }
  }
}

/**
 * JSON 解析兜底：解析成功且 parse 返回片段则用之；否则走 onParseFailure
 * （各 handler 的失败语义不同：保留原文 / degraded / fail-open skipped）。
 * parse 回调同时接收 raw（与 onParseFailure 参数一致，供构造输出时引用）。
 * @param raw - LLM 原始输出文本。
 * @param parse - 解析成功后的转换回调。
 * @param onParseFailure - 解析失败或 parse 返回 null 时的兜底回调。
 * @returns 转换后的状态片段。
 */
export function parseLlmJson(
  raw: string,
  parse: (parsed: Record<string, unknown>, raw: string) => PipelineState | null,
  onParseFailure: (raw: string) => PipelineState,
): PipelineState {
  const parsed = tryParseJson(raw)
  if (parsed !== undefined) {
    const segment = parse(parsed, raw)
    if (segment !== null) return segment
  }
  return onParseFailure(raw)
}
