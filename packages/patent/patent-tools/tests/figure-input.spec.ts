import { describe, expect, it } from 'vitest'
import type { FigureAnalysisResult } from '../src/tool/analyze-patent-figure.ts'
import {
  assertViewName,
  collectFigureWording,
  dotDocumentTitle,
  figureViewName,
  presentStructuralFields,
  resolveFamilySeeds,
  vectorTitle,
  type GeneratePatentFigureDeps,
  type StructuralFigureInput,
} from '../src/tool/figure-input.ts'

/** 一份空的结构化输入，按需覆盖单个字段。 */
function structural(patch: Partial<StructuralFigureInput> & Pick<StructuralFigureInput, 'figure_type'>): StructuralFigureInput {
  return {
    steps: [],
    states: [],
    transitions: [],
    blocks: [],
    connections: [],
    tree: [],
    ...patch,
  }
}

/** 索引条目里的最小附图分析结果。 */
function entry(analysis: Partial<FigureAnalysisResult>): { imagePath: string; analyzedAt: string; analysis: FigureAnalysisResult } {
  return {
    imagePath: 'fig1.svg',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    analysis: {
      imagePath: 'fig1.svg',
      figureNumber: 1,
      figureType: 'structure',
      overallDescription: '',
      components: [],
      connections: [],
      figureDescription: '',
      confidence: 1,
      warnings: [],
      usable: true,
      modelUsed: 'test',
      ...analysis,
    },
  }
}

describe('presentStructuralFields', () => {
  it('lists states as a state diagram input', () => {
    expect(presentStructuralFields({ states: [{ id: 's1', label: '待机' }] })).toEqual([
      { field: 'states', figureType: 'state_diagram' },
    ])
  })

  it('keeps the fixed field order when several inputs are present', () => {
    expect(presentStructuralFields({
      steps: [{ id: 'a', label: 'A', next: [] }],
      states: [{ id: 's', label: 'B' }],
      blocks: [{ id: 'b', label: 'C' }],
      tree: [{ id: 't', label: 'D' }],
      dot: 'digraph{}',
      template: 'system_block',
    }).map(item => item.field)).toEqual(['steps', 'states', 'blocks', 'tree', 'dot', 'template'])
  })
})

describe('collectFigureWording', () => {
  it('collects inline edge labels from flowchart steps', () => {
    expect(collectFigureWording(structural({
      figure_type: 'flowchart',
      steps: [
        { id: 'a', label: '开始', next: ['b', { id: 'c', label: '分支' }] },
        { id: 'b', label: '结束', next: [] },
      ],
    }))).toEqual(['开始', '分支', '结束'])
  })

  it('collects state and block labels including edge labels', () => {
    expect(collectFigureWording(structural({
      figure_type: 'state_diagram',
      states: [{ id: 's1', label: '待机' }, { id: 's2', label: '运行' }],
      transitions: [{ from: 's1', to: 's2' }, { from: 's2', to: 's1', label: '复位' }],
    }))).toEqual(['待机', '运行', '复位'])

    expect(collectFigureWording(structural({
      figure_type: 'block_diagram',
      blocks: [{ id: 'a', label: '输入' }, { id: 'b', label: '输出' }],
      connections: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a', label: '反馈' }],
    }))).toEqual(['输入', '输出', '反馈'])
  })

  it('recurses into every hierarchy node', () => {
    expect(collectFigureWording(structural({
      figure_type: 'component_hierarchy',
      tree: [{ id: 'root', label: '系统', children: [{ id: 'child', label: '组件' }] }],
    }))).toEqual(['系统', '组件'])
  })

  it('decodes escaped characters in raw DOT labels', () => {
    const dot = 'digraph{a [label="第一行\\n第二行\\"引号\\""];}'
    expect(collectFigureWording(structural({ figure_type: 'raw_dot', dot })))
      .toEqual(['第一行\n第二行"引号"'])
  })

  it('returns no wording for template and vector figure types', () => {
    expect(collectFigureWording(structural({ figure_type: 'template', template: 'method_steps' }))).toEqual([])
    for (const figureType of ['circuit', 'plot', 'cross_section', 'sequence_diagram', 'appearance_view'] as const) {
      expect(collectFigureWording(structural({ figure_type: figureType })), figureType).toEqual([])
    }
  })
})

describe('vectorTitle', () => {
  it('prefixes the invention name when one is given', () => {
    expect(vectorTitle('一种检测装置', 'circuit')).toBe('一种检测装置的电路图')
    expect(vectorTitle('  ', 'plot')).not.toContain('的曲线图')
    expect(vectorTitle(undefined, 'plot')).toBe(vectorTitle('', 'plot'))
  })

  it('keeps the figure-type name when view_name is omitted or blank', () => {
    expect(vectorTitle('汇聚箱', 'cross_section')).toBe('汇聚箱的剖视图')
    expect(vectorTitle('汇聚箱', 'cross_section', '   ')).toBe('汇聚箱的剖视图')
    expect(figureViewName('cross_section', undefined)).toBe('剖视图')
  })

  it('replaces only the view name when view_name is set', () => {
    expect(vectorTitle('汇聚箱', 'cross_section', '  主视半剖视图  ')).toBe('汇聚箱的主视半剖视图')
    expect(figureViewName('unknown', '主视半剖视图')).toBe('主视半剖视图')
    expect(dotDocumentTitle('汇聚箱', 'unknown', undefined)).toBeUndefined()
    expect(dotDocumentTitle('汇聚箱', 'unknown', '  ')).toBeUndefined()
    expect(dotDocumentTitle('汇聚箱', 'unknown', '主视半剖视图')).toBe('汇聚箱的主视半剖视图')
  })
})

describe('assertViewName', () => {
  it('rejects a newline and a trimmed name longer than 200 characters', () => {
    expect(() => { assertViewName(undefined) }).not.toThrow()
    expect(() => { assertViewName('   ') }).not.toThrow()
    expect(() => { assertViewName('主视（半剖）视图') }).not.toThrow()
    expect(() => { assertViewName('主视\n半剖') }).toThrow('view_name 不能包含换行')
    expect(() => { assertViewName('主视\r半剖') }).toThrow('view_name 不能包含换行')
    expect(() => { assertViewName(` ${'视'.repeat(200)} `) }).not.toThrow()
    expect(() => { assertViewName('视'.repeat(201)) }).toThrow('view_name 去掉首尾空白后不能超过 200 个字符')
  })
})

describe('resolveFamilySeeds', () => {
  it('returns an empty seed without a family or without reading the index', async () => {
    const deps = {} as GeneratePatentFigureDeps
    expect(await resolveFamilySeeds(undefined, [], deps)).toEqual({ explicit: {}, reserved: [] })
  })

  it('skips index components without a name or reference number', async () => {
    const deps: GeneratePatentFigureDeps = {
      render: async () => ({ ok: false, code: 'render_failed', error: 'unused' }),
      loadIndex: async () => [
        entry({
          figureFamily: 'F1',
          components: [
            { refNumber: '100', name: '  ', kind: 'mechanical', description: '' },
            { refNumber: ' ', name: '壳体', kind: 'mechanical', description: '' },
            { refNumber: '102', name: '壳体', kind: 'mechanical', description: '' },
            { refNumber: '103', name: '壳体', kind: 'mechanical', description: '' },
            { refNumber: '104', name: '盖板', kind: 'mechanical', description: '' },
          ],
        }),
      ],
    }
    const seeds = await resolveFamilySeeds('F1', [
      { id: 'shell', label: '壳体' },
      { id: 'cover', label: '未在索引中' },
    ], deps)
    expect(seeds.explicit).toEqual({ shell: '102' })
    expect(seeds.reserved).toEqual(['104'])
  })

  it('reports a non-Error index read failure', async () => {
    const deps: GeneratePatentFigureDeps = {
      render: async () => ({ ok: false, code: 'render_failed', error: 'unused' }),
      loadIndex: async () => {
        throw 'index broken'
      },
    }
    await expect(resolveFamilySeeds('F1', [], deps)).rejects.toThrow('读取附图索引失败：index broken')
  })

  it('reports an Error index read failure with its message', async () => {
    const deps: GeneratePatentFigureDeps = {
      render: async () => ({ ok: false, code: 'render_failed', error: 'unused' }),
      loadIndex: async () => {
        throw new Error('index missing')
      },
    }
    await expect(resolveFamilySeeds('F1', [], deps)).rejects.toThrow('读取附图索引失败：index missing')
  })
})
