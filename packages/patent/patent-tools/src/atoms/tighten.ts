/**
 * 篇幅域原子：tighten（删减阶段）。
 *
 * 撰写阶段（`draft`）教模型「写多少」，本阶段负责「写多了怎么减」：输入是已经
 * 写完的答复正文与篇幅预算，输出是删减后的正文、逐条删除清单与残留超标项。
 *
 * 为什么是原子而不是纯 guidance 阶段：模型产出必须过一道机械校验。删减的验收
 * 标准是字数，而字数是可以算的——模型说「已删减」但没减到预算内时，本原子直接
 * 降级，不把超预算的正文写成 `draft_tightened` 让下游与用户以为已收口。
 *
 * 正文本来就在预算内时不调模型：`draft` 阶段已按预算写过，此时删减没有目标，
 * 调一次只会拿回原文（并在会话记录里再存一份全文）。原文原样交付，报告照实写
 * 「已在预算内」，也不因此要求配置 LLM。
 *
 * 依赖方向与 `slop-gate` / `response-check` 一致：可见字符口径来自本包的 slop
 * 引擎（`visibleChars`），LLM 调用骨架来自 patent-core 的 `callLlm`
 * （取消与重试语义与内置模型原子一致）。
 */

import {
  type Atom,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  callLlm,
  degraded,
  getStateString,
  parseLlmJson,
  requireLlm,
  visibleChars,
} from '@deepseek-ai/dsh-patent-core'
import { readCharBudget } from '../internal/stage-params.ts'

/** 缺省受理文本键（`draft` 阶段的输出键）。 */
export const DEFAULT_TIGHTEN_TEXT_KEY = 'draft'

/** 缺省答复计划键（只读其决策段，用于判断哪些内容属于复述）。 */
export const DEFAULT_TIGHTEN_PLAN_KEY = 'response-plan'

/** 送进提示的正文上限：再长也只截断一次，避免删减阶段自己撞上下文上限。 */
const TIGHTEN_PROMPT_LIMIT = 20_000

/** 删减项：删了什么、为什么可删。 */
type TightenRemoval = {
  /** 删掉的内容（要点，不是原文全文）。 */
  what: string
  /** 可删的理由（属于哪一类删减）。 */
  why: string
}

/** 阶段参数 `char_budget` 的读取结果见 `internal/stage-params.ts`；它与 `slop-gate` 共用同一实现。 */

/** tighten 原子：按篇幅预算删减答复正文，并对字数做机械校验。 */
export const tightenAtom: Atom = {
  name: 'tighten',
  description: '删减阶段：按篇幅预算删除答复正文中的复述、重复与无关事实，输出删减后的正文与逐条删除清单；正文已在预算内时原样放行、不调用模型；模型产出未减到预算内时降级，不静默放行',
  category: 'extract',
  inputSchema: ['draft', 'text_key', 'response-plan', 'plan_key', 'char_budget'],
  outputSchema: ['draft_tightened', 'tighten_report', 'tighten_violations'],
  usesModel: true,
}

/**
 * 读取阶段参数里的宽限键：缺省取 fallback，声明了但为空/非字符串则视为非法。
 * @param state - 阶段执行态（阶段参数已合入）。
 * @param key - 参数键。
 * @param fallback - 缺省键。
 * @returns 键名；参数已声明但非法时返回 undefined。
 */
function resolveKey(state: PipelineState, key: string, fallback: string): string | undefined {
  const raw = state[key]
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  return raw.trim()
}

/**
 * 解析模型返回的 `removed`（非法项丢弃，不让格式抖动换掉整次删减）。
 * @param raw - 模型返回的 `removed` 原始值。
 * @returns 合法的删除项列表（可能为空）。
 */
function readRemovals(raw: unknown): TightenRemoval[] {
  if (!Array.isArray(raw)) return []
  const out: TightenRemoval[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const what = typeof record.what === 'string' ? record.what.trim() : ''
    const why = typeof record.why === 'string' ? record.why.trim() : ''
    if (what.length > 0 && why.length > 0) out.push({ what, why })
  }
  return out
}

/**
 * 拼删减阶段提示词。
 * @param draft - 待删减的正文。
 * @param plan - 答复计划（可为空）。
 * @param before - 当前可见字符数。
 * @param budget - 篇幅预算（未声明时为 undefined）。
 * @returns 提示词。
 */
function buildPrompt(draft: string, plan: string, before: number, budget: number | undefined): string {
  const budgetLine = budget === undefined
    ? `【当前篇幅】可见字符 ${String(before)} 字（去空白，不含表格与权利要求全文）；本次未声明预算，按删减顺序处理明显的复述与重复。`
    : `【当前篇幅】可见字符 ${String(before)} 字，预算 ${String(budget)} 字，至少需删 ${String(Math.max(before - budget, 0))} 字。`
  return [
    '你是专利代理师，负责把一份已经写好的意见陈述书正文压进篇幅预算。只删不写。',
    '硬约束：',
    '- 不新增论证、不改写结论、不调整法律定性；不得改动任何事实编号（F/P）、规则编号（R）、证据标号与段落号',
    '- 保留八节结构与节标题顺序；某节删空则整节删除，不留空标题，也不写「无」「本案不涉及…」式占位句',
    '- 删减顺序：复述审查意见 → 复述法条原文 → 与争点无关的事实 → 同一论点的第二遍表述',
    '- 表格与「修改后的独立权利要求」全文不计入字数，也不要整块删除；篇幅只能靠删散文来降',
    '- 必须真的删：removed 列了什么，正文里就必须已经不在；原样返回等于本阶段失败',
    '- 宁可整段删除，也不把句子压成读者猜得出来的半句',
    '',
    budgetLine,
    ...(plan.trim().length > 0
      ? ['【答复计划（只读其决策段：哪些理由已定策略、哪些内容属复述）】', plan.slice(0, TIGHTEN_PROMPT_LIMIT), '']
      : []),
    '【待删减的正文】',
    draft.slice(0, TIGHTEN_PROMPT_LIMIT),
    '',
    '只输出一个 JSON 对象，不要前言、不要代码围栏：tightened 为删减后的完整正文（Markdown，不省略任何保留段落），removed 为逐条删除项（what 写删了什么，why 写为什么可删）。',
  ].join('\n')
}

/**
 * 拼删减阶段的产出报告。
 * @param before - 删减前的可见字符数。
 * @param after - 删减后的可见字符数。
 * @param budget - 篇幅预算（未声明时为 undefined）。
 * @param removed - 逐条删除项。
 * @returns 人读报告。
 */
function formatReport(
  before: number,
  after: number,
  budget: number | undefined,
  removed: readonly TightenRemoval[],
): string {
  const head = `删减阶段: ${String(before)} → ${String(after)} 字（${
    budget === undefined ? '未声明预算' : `预算 ${String(budget)} 字`
  }）`
  if (removed.length > 0) return [head, ...removed.map(item => `- ${item.what}：${item.why}`)].join('\n')
  // 字数变了却没清单：说明模型只交了正文。报告如实写明，不编造删除理由。
  if (after < before) return `${head}\n- 逐条清单缺失（模型只交正文，实际少 ${String(before - after)} 字）`
  return `${head}\n- 未删除任何内容`
}

/**
 * 已在预算内时的产出报告。
 * @param chars - 可见字符数（删减前后相同）。
 * @param budget - 篇幅预算。
 * @returns 人读报告。
 */
function withinBudgetReport(chars: number, budget: number): string {
  return `删减阶段: ${String(chars)} → ${String(chars)} 字（预算 ${String(budget)} 字）\n- 已在预算内，未调用模型`
}

/** tighten 执行器：调模型删减，再用可见字符数机械校验。 */
export class TightenHandler implements StageHandler {
  readonly name = 'tighten'
  readonly category = 'extract' as const

  /**
   * 执行 tighten 阶段，返回下一管线状态。
   * @param input - 阶段执行输入（state 中已合入阶段参数）。
   * @returns 下一管线状态；未达验收标准时返回降级片段。
   */
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state, provider, signal } = input
    const textKey = resolveKey(state, 'text_key', DEFAULT_TIGHTEN_TEXT_KEY)
    if (textKey === undefined) return degraded('tighten', 'params.text_key 必须是非空字符串')
    const planKey = resolveKey(state, 'plan_key', DEFAULT_TIGHTEN_PLAN_KEY)
    if (planKey === undefined) return degraded('tighten', 'params.plan_key 必须是非空字符串')
    const budget = readCharBudget(state)
    if (budget.kind === 'invalid') return degraded('tighten', 'params.char_budget 必须是正整数')
    const draft = getStateString(state, textKey).trim()
    if (draft.length === 0) return degraded('tighten', `输入为空（${textKey}）`)
    const before = visibleChars(draft)
    const carriersBefore = countCarriers(draft)
    // 已在预算内：无删减目标，原样交付，不花一次模型调用，也不要求配 LLM。
    if (budget.value !== undefined && before <= budget.value) {
      return {
        draft_tightened: draft,
        tighten_report: withinBudgetReport(before, budget.value),
        tighten_violations: '',
      }
    }
    const missing = requireLlm(provider, 'tighten')
    if (missing !== null) return missing
    const prompt = buildPrompt(draft, getStateString(state, planKey), before, budget.value)
    const res = await callLlm(provider, 'tighten', prompt, {
      temperature: 0.1,
      schema: {
        type: 'object',
        properties: {
          tightened: { type: 'string', description: '删减后的完整正文' },
          removed: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                what: { type: 'string', description: '删掉了什么' },
                why: { type: 'string', description: '为什么可删' },
              },
              required: ['what', 'why'],
            },
          },
        },
        required: ['tightened'],
      },
    }, signal)
    if (!res.ok) return res.error
    // 格式容错：模型交 JSON 时连清单一起收；只交正文（模型不走 JSON 通道）时
    // 仍按正文走同一道字数核对——宁可清单缺失，也不因格式抖动让整条答复链降级。
    return parseLlmJson(
      res.raw,
      parsed => this.judge(parsed.tightened, readRemovals(parsed.removed), before, budget.value, carriersBefore),
      raw => this.judge(raw, [], before, budget.value, carriersBefore),
    )
  }

  /**
   * 对模型产出做机械校验，决定写入还是降级。
   * @param rawTightened - 模型给出的删减后正文（可能是 JSON 字段，也可能是整段回文）。
   * @param removed - 逐条删除项（格式容错路径下为空）。
   * @param before - 删减前的可见字符数。
   * @param budget - 篇幅预算（未声明时为 undefined）。
   * @param carriersBefore - 删减前的载体块计数（表格与修改后独权全文）。
   * @returns 产出片段或降级片段。
   */
  private judge(
    rawTightened: unknown,
    removed: readonly TightenRemoval[],
    before: number,
    budget: number | undefined,
    carriersBefore: CarrierCount,
  ): PipelineState {
    const tightened = typeof rawTightened === 'string' ? stripFence(rawTightened).trim() : ''
    if (tightened.length === 0) return degraded('tighten', '模型返回的 tightened 为空')
    const after = visibleChars(tightened)
    // 原样返回是最常见的伪删减：模型在 removed 里列了删项，正文却一字未动。
    // 与「删了但没删够」分开报，本阶段的失败原因才可判（见 PR-12 的真实草稿录制）。
    // 未声明预算时不判等长：此时没有「必须删到多少」的目标，原文交回是可接受的产出。
    if (budget !== undefined && after === before) {
      return {
        ...degraded('tighten', `模型原样返回、未删除任何内容（可见字符 ${String(before)} 字未变）`),
        tighten_violations: `未删减：${String(before)} > ${String(budget)}（需删 ${String(before - budget)} 字）`,
      }
    }
    if (after > before) {
      return degraded('tighten', `删减后反而变长（可见字符 ${String(before)} → ${String(after)}）`)
    }
    if (budget !== undefined && after > budget) {
      return {
        ...degraded('tighten', `删减后仍超预算（可见字符 ${String(after)} > 预算 ${String(budget)}，需再删 ${String(after - budget)} 字）`),
        tighten_violations: `仍超预算：${String(after)} > ${String(budget)}（需再删 ${String(after - budget)} 字）`,
      }
    }
    // 载体块不计入字数，删它减不了篇幅；少一张表就是少一份交付载体（表 1 与 2.1 全文
    // 是 D-1 要求的两份），故即使字数达标也记一条残留项，交人工复核。
    const carriersAfter = countCarriers(tightened)
    const lost: string[] = []
    if (carriersAfter.tables < carriersBefore.tables) {
      lost.push(`删掉了 ${String(carriersBefore.tables - carriersAfter.tables)} 张表（表 1/2/3 是交付载体）`)
    }
    if (carriersAfter.claimText < carriersBefore.claimText) {
      lost.push('删掉了「修改后的独立权利要求」全文（D-1 要求与对照表同时保留）')
    }
    return {
      draft_tightened: tightened,
      tighten_report: formatReport(before, after, budget, removed),
      tighten_violations: lost.join('；'),
    }
  }
}

/** 载体块计数：表格与「修改后的独立权利要求」全文（它们不计入篇幅，也不得被删）。 */
type CarrierCount = {
  /** 表格块数（HTML `<table` 与 Markdown 表头分隔行各算一张）。 */
  tables: number
  /** 修改后独权全文块数（HTML `claim-text` 元素与 Markdown 对应标题）。 */
  claimText: number
}

/**
 * 数出正文里的载体块。
 *
 * 只用于「删减前后是否少了一块」的比对，不判内容：删减阶段无权重写表格与权项全文。
 * @param text - 正文（HTML 或 Markdown）。
 * @returns 载体块计数。
 */
function countCarriers(text: string): CarrierCount {
  const counts = (pattern: RegExp): number => (text.match(pattern) ?? []).length
  return {
    tables: counts(/<table\b/gi) + counts(/^\s*\|[\s:|-]+\|\s*$/gm),
    claimText: counts(/\bclass=["'][^"']*\bclaim-text\b/gi)
      + counts(/^#{1,6}\s.*(?:修改后的独立权利要求|修改后的权利要求全文)/gm),
  }
}

/**
 * 去掉模型包在正文外的 ``` 围栏（只处理首尾各一行围栏，不动正文内的代码块）。
 * @param raw - 模型回文。
 * @returns 去掉围栏后的正文。
 */
function stripFence(raw: string): string {
  const text = raw.trim()
  const end = text.lastIndexOf('\n')
  // 不足三行时没有可剥的围栏：配对的围栏至少还得夹住一行正文。
  if (end < 0) return raw
  if (text.lastIndexOf('\n', end - 1) < 0) return raw
  const start = text.indexOf('\n')
  if (!text.slice(0, start).startsWith('```')) return raw
  // 首尾必须成对：只有开头围栏时按原文交，免得把正文第一行当围栏吃掉。
  if (text.slice(end + 1) !== '```') return raw
  return text.slice(start + 1, end)
}
