import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import { renderWithVizWasm } from '../src/figure/viz-wasm-renderer.ts'
import { blockingFindings, checkFigureRendering, clearanceMmForFigure } from '../src/figure/render-check.ts'
import { buildVectorFigure } from '../src/figure/vector-figure-build.ts'
import { vectorFigureSvg } from '../src/figure/vector-figure.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/**
 * 净距分档的实测护栏：现有合法输出在各自阈值下必须零阻断。
 *
 * 分档表（`RENDER_CLEARANCE_MM`）的数值来自这些图型的实测排版间距；本文件把
 * 「实测值仍然成立」变成 CI 信号——图型模块把标签挪近、或分档表被调高，都会在
 * 这里变红，而不是等到真实案件里被 strict 门禁误杀。
 */

const signal = new AbortController().signal

async function generateGraphviz(input: Record<string, unknown>): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-figure-live-'))
  ctx.tools.register(createGeneratePatentFigureTool({
    render: renderWithVizWasm,
    outputDir: dir,
    cwd: dir,
    resolveFont: () => 'Helvetica',
  }))
  try {
    const result = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId(String(input.figure_type)),
      name: 'generate_patent_figure',
      arguments: { ...input, persist_index: false },
    })
    expect(result.isError).toBe(false)
    const value = (result as never as { value: { absolutePath: string } }).value
    return readFileSync(value.absolutePath, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 生成图的阻断级发现；`not-measured` 不算阻断，故只断言真实缺陷为空。 */
function blocking(svg: string, figureType: string) {
  const report = checkFigureRendering(svg, { textClearanceMm: clearanceMmForFigure(figureType) })
  return blockingFindings(report).map(finding => `${finding.check}: ${finding.message}`)
}

describe('现有合法出图在分档净距下零阻断（Graphviz）', () => {
  it('flowchart：内嵌标号与节点框留白充足', async () => {
    const svg = await generateGraphviz({
      figure_type: 'flowchart',
      steps: [
        { id: 's1', label: '开始', next: ['s2'] },
        { id: 's2', label: '采集数据', next: ['s3'] },
        { id: 's3', label: '判断是否超限', shape: 'diamond', next: [{ id: 's4', label: '是' }] },
        { id: 's4', label: '结束', next: [] },
      ],
    })
    expect(blocking(svg, 'flowchart')).toEqual([])
  })

  it('state_diagram：边标签与自己的边同组，不再判穿字', async () => {
    const svg = await generateGraphviz({
      figure_type: 'state_diagram',
      states: [
        { id: 'a', label: '待机' },
        { id: 'b', label: '运行' },
        { id: 'c', label: '故障' },
      ],
      transitions: [
        { from: 'a', to: 'b', label: '启动' },
        { from: 'b', to: 'c', label: '超限' },
      ],
    })
    expect(blocking(svg, 'state_diagram')).toEqual([])
  })

  it('block_diagram：引线标号贴在框外属于设计间距，阈值 0.5 不误报', async () => {
    const svg = await generateGraphviz({
      figure_type: 'block_diagram',
      blocks: [
        { id: 'a', label: '传感器' },
        { id: 'b', label: '控制器' },
        { id: 'c', label: '执行器' },
      ],
      connections: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    })
    expect(blocking(svg, 'block_diagram')).toEqual([])
  })
})

describe('现有合法出图在分档净距下零阻断（直绘）', () => {
  const cases = {
    circuit: {
      circuit: {
        components: [
          { id: 'v1', kind: 'voltage_source', label: '电源', col: 0, row: 0 },
          { id: 'r1', kind: 'resistor', label: '电阻', col: 1, row: 0 },
          { id: 'l1', kind: 'lamp', label: '灯泡', col: 2, row: 0 },
        ],
        connections: [
          { from: 'v1', to: 'r1' },
          { from: 'r1', to: 'l1' },
        ],
      },
    },
    plot: {
      plot: {
        series: [{ name: '升温曲线', points: [[0, 20], [10, 60], [20, 95]] }],
        x_label: '时间',
        y_label: '温度',
        x_unit: 's',
        y_unit: '℃',
      },
    },
    sequence_diagram: {
      sequence: {
        participants: [{ id: 'a', label: '客户端' }, { id: 'b', label: '服务器' }],
        messages: [
          { from: 'a', to: 'b', label: '发送请求' },
          { from: 'b', to: 'a', label: '返回结果', kind: 'return' as const },
        ],
      },
    },
  } as const

  for (const [figureType, input] of Object.entries(cases)) {
    it(`${figureType}：元件名/刻度/消息字与图线留白在设计间距内`, () => {
      const { spec } = buildVectorFigure(figureType as keyof typeof cases, input)
      expect(blocking(vectorFigureSvg(spec), figureType)).toEqual([])
    })
  }
})
