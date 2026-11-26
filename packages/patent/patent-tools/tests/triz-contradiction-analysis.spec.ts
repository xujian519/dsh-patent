import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PatentModelPort } from '@deepseek-ai/dsh-patent-core'
import { createTrizContradictionAnalysisTool, renderTrizContradictionAnalysis } from '../src/tool/triz-contradiction-analysis.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

const SOURCE = '本方案增大预紧力以提升结构稳定性，但预紧力增大后装配耗时明显增加，产线节拍下降。'

/** 随包矩阵中 improving=3、worsening=1 有推荐原理（8/15/29/34）；此处只用它的存在性。 */
const RECOMMENDED_CELL = { improving: 3, worsening: 1 }

function jsonModel(json: string): PatentModelPort {
  return {
    stream: async function* () {
      yield { type: 'delta' as const, text: json }
      yield { type: 'done' as const }
    },
  }
}

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

describe('triz_contradiction_analysis', () => {
  it('识别矛盾、核验证据并把方案方向与补强清单渲染到模型可见文本', async () => {
    const cell = RECOMMENDED_CELL
    const model = jsonModel(JSON.stringify({
      contradictions: [
        {
          improving: cell.improving,
          worsening: cell.worsening,
          statement: '提升结构稳定性同时牺牲节拍',
          evidence: '增大预紧力以提升结构稳定性',
          solution_directions: ['预紧力改为分组可调'],
        },
        {
          improving: cell.improving,
          worsening: cell.worsening,
          statement: '原文没有依据的矛盾',
          evidence: '这句话不在交底书里',
        },
      ],
      parameter_gaps: [{ parameter: 17, missing: ['target-value', 'unit'], detail: '只写加热，未给温度范围' }],
      unmapped: [{ statement: '提高客户满意度', reason: '非工程参数' }],
    }))
    const ctx = await ctxWith(createTrizContradictionAnalysisTool({ model }))
    const result = await execute(ctx, 'triz_contradiction_analysis', { text: SOURCE }, 'tca-1')

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('矛盾 1 条')
    expect(out).toContain('其中证据未定位丢弃 1 条')
    expect(out).toContain('## 技术矛盾')
    expect(out).toContain('改善「')
    expect(out).toContain('增大预紧力以提升结构稳定性')
    expect(out).toContain('推荐原理：')
    expect(out).toContain('预紧力改为分组可调')
    expect(out).toContain('## 参数完备性缺口（交底书补强清单）')
    expect(out).toContain('温度（17）：缺目标值、缺单位 —— 只写加热，未给温度范围')
    expect(out).toContain('## 未采纳')
    expect(out).toContain('提高客户满意度 —— 非工程参数')
    expect(out).toContain('候选 PFIE 单元 1 条')
    expect(out).toContain('## 候选 PFIE 单元（待发明人确认，未进四元组表）')
    expect(out).toContain('- K1 ← C1')
    expect(out).toContain('特征（无原文锚点）：预紧力改为分组可调')

    const value = (
      result as {
        value?: {
          dropped_for_evidence?: number
          contradictions?: unknown[]
          candidate_units?: Array<{ id: string; feature: string; status: string; contradictionId: string }>
          candidate_skips?: unknown[]
        }
      }
    ).value
    expect(value?.dropped_for_evidence).toBe(1)
    expect(value?.contradictions).toHaveLength(1)
    expect(value?.candidate_skips).toEqual([])
    expect(value?.candidate_units).toHaveLength(1)
    expect(value?.candidate_units?.[0]).toMatchObject({
      id: 'K1',
      contradictionId: 'C1',
      feature: '预紧力改为分组可调',
      status: 'pending-inventor-confirmation',
    })
  })

  it('物理矛盾的方案方向只计入 candidate_skips，不折出候选', async () => {
    const model = jsonModel(JSON.stringify({
      contradictions: [{
        improving: 5, worsening: 5,
        statement: '既想要节拍又想要稳定性',
        evidence: '产线节拍下降',
        solution_directions: ['分时段切换预紧力档位'],
      }],
    }))
    const ctx = await ctxWith(createTrizContradictionAnalysisTool({ model }))
    const result = await execute(ctx, 'triz_contradiction_analysis', { text: SOURCE }, 'tca-physical')

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('- C1：1 条方案方向无推荐原理可依（物理矛盾（对角格，经典矩阵无条目）），未折出候选')

    const value = (result as { value?: { candidate_units?: unknown[]; candidate_skips?: unknown[] } }).value
    expect(value?.candidate_units).toEqual([])
    expect(value?.candidate_skips).toHaveLength(1)
  })

  it('text 为空 → 输入错误，不调用模型', async () => {
    const ctx = await ctxWith(createTrizContradictionAnalysisTool({ model: jsonModel('{}') }))
    const result = await execute(ctx, 'triz_contradiction_analysis', { text: '   ' }, 'tca-2')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('text 为空')
  })

  it('未注入模型端口 → setup_required', async () => {
    const ctx = await ctxWith(createTrizContradictionAnalysisTool())
    const result = await execute(ctx, 'triz_contradiction_analysis', { text: SOURCE }, 'tca-3')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('未配置 LLM')
  })

  it('模型输出不是 JSON → 执行失败并带原因', async () => {
    const ctx = await ctxWith(createTrizContradictionAnalysisTool({ model: jsonModel('不是 JSON') }))
    const result = await execute(ctx, 'triz_contradiction_analysis', { text: SOURCE }, 'tca-4')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('JSON')
  })

  it('focus 参数进入识别调用', async () => {
    const model = jsonModel(JSON.stringify({ contradictions: [], parameter_gaps: [], unmapped: [] }))
    const ctx = await ctxWith(createTrizContradictionAnalysisTool({ model }))
    const result = await execute(ctx, 'triz_contradiction_analysis', { text: SOURCE, focus: '节拍' }, 'tca-5')

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('矛盾 0 条')
  })
})

describe('renderTrizContradictionAnalysis', () => {
  it('空产物渲染出明确的零结果说明', () => {
    const out = renderTrizContradictionAnalysis({
      contradictions: [],
      parameter_gaps: [],
      unmapped: [],
      dropped_for_evidence: 0,
    })

    expect(out).toContain('矛盾 0 条')
    expect(out).toContain('候选 PFIE 单元 0 条')
    expect(out).toContain('未识别到有原文证据支撑的技术矛盾。')
    expect(out).toContain('无候选：矛盾未给出方案方向，或所落矩阵格无推荐原理。')
    expect(out).toContain('无缺口记录。')
    expect(out).not.toContain('## 未采纳')
  })

  it('非对象输入不抛错', () => {
    expect(renderTrizContradictionAnalysis(undefined)).toBe('triz_contradiction_analysis: 无结果')
  })

  it('矩阵空缺与物理矛盾不给推荐原理', () => {
    const out = renderTrizContradictionAnalysis({
      contradictions: [
        { id: 'C1', improving: { number: 1, name: '运动物体重量' }, worsening: { number: 1, name: '运动物体重量' }, statement: 's', evidence: 'e', principles: [], matrixStatus: 'physical', solutionDirections: [] },
        { id: 'C2', improving: { number: 2, name: '静止物体重量' }, worsening: { number: 3, name: '运动物体长度' }, statement: 's', evidence: 'e', principles: [], matrixStatus: 'gap', solutionDirections: [] },
      ],
      parameter_gaps: [],
      unmapped: [],
      dropped_for_evidence: 0,
    })

    expect(out).toContain('物理矛盾（对角格，经典矩阵无条目）')
    expect(out).toContain('矩阵转录空缺（无推荐原理）')
    expect(out.match(/推荐原理：无（矩阵无条目或转录空缺）/g)).toHaveLength(2)
  })

  it('候选段给出待确认候选与未折出候选的矛盾', () => {
    const out = renderTrizContradictionAnalysis({
      contradictions: [],
      parameter_gaps: [],
      unmapped: [],
      dropped_for_evidence: 0,
      candidate_units: [{
        id: 'K1',
        contradictionId: 'C2',
        problem: '提升稳定性同时牺牲节拍',
        insight: '借助15 动态性化解「运动物体长度」与「运动物体重量」的取舍',
        feature: '把预紧力改为可调分组',
        effect: '改善运动物体长度，且不以牺牲运动物体重量为代价',
        principles: [{ number: 15, name: '动态性' }],
        contradictionEvidence: '预紧力增大后装配耗时明显增加',
        status: 'pending-inventor-confirmation',
      }],
      candidate_skips: [{ contradictionId: 'C1', matrixStatus: 'physical', directionCount: 2 }],
    })

    expect(out).toContain('- K1 ← C2')
    expect(out).toContain('发明认知（原理推导，非发明人陈述）：借助15 动态性')
    expect(out).toContain('特征（无原文锚点）：把预紧力改为可调分组')
    expect(out).toContain('所依原理：15 动态性')
    expect(out).toContain('- C1：2 条方案方向无推荐原理可依（物理矛盾（对角格，经典矩阵无条目）），未折出候选')
    expect(out.indexOf('## 候选 PFIE 单元')).toBeLessThan(out.indexOf('## 参数完备性缺口'))
  })

  it('renders malformed entries defensively without throwing', () => {
    const out = renderTrizContradictionAnalysis({
      contradictions: [
        null,
        {
          id: 5,
          improving: null,
          worsening: { name: '恶化参数' },
          statement: 7,
          evidence: 8,
          principles: [null, { number: 3 }, { name: '局部质量' }],
          matrixStatus: 'unknown-status',
          solutionDirections: ['候选方向', ''],
        },
      ],
      parameter_gaps: [null, { parameter: 7, missing: ['unknown-kind', ''], detail: '' }],
      unmapped: [null, { statement: '', reason: 'r' }],
      dropped_for_evidence: 'not-a-number',
      candidate_units: [
        null,
        {
          id: '',
          contradictionId: 9,
          problem: null,
          insight: 11,
          feature: 12,
          effect: 13,
          principles: [null, { number: 3 }, { name: '局部质量' }],
          contradictionEvidence: 14,
          status: 'confirmed',
        },
      ],
      candidate_skips: [null, { contradictionId: 'C7', matrixStatus: 'unknown-status', directionCount: 'x' }],
    })

    expect(out).toContain('C2 改善「未命名参数」↔ 恶化「恶化参数」｜unknown-status')
    expect(out).toContain('推荐原理：3；局部质量')
    expect(out).toContain('候选方案方向：')
    expect(out).toContain('- 未命名参数：unknown-kind')
    expect(out).toContain('证据未定位丢弃 0 条')
    expect(out).toContain('## 未采纳')
    expect(out).toContain('- K2 ← ')
    expect(out).toContain('  - 所依原理：3；局部质量')
    expect(out).toContain('- C7：0 条方案方向无推荐原理可依（unknown-status），未折出候选')
  })
})
