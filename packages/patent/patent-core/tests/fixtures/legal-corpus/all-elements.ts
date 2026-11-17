import type { AllElementsOutcome } from '@deepseek-ai/dsh-patent-core'
import type {
  ChartRow,
  ClaimElement,
  Mapping,
} from '../../../src/claim-chart/protocol/types.ts'

/** 金标语料：全面覆盖原则。 */
export type AllElementsCase = {
  engine: 'all-elements'
  id: string
  title: string
  rows: readonly ChartRow[]
  elements: readonly ClaimElement[]
  targetId: string
  expected: {
    outcome: AllElementsOutcome
    literal: readonly string[]
    missing: readonly string[]
  }
}

/**
 * 构造一条权利要求要素。
 * @param id - 要素 id（数字前缀为权项号）。
 * @returns 权利要求要素。
 */
function element(id: string): ClaimElement {
  return { id, claimNo: Number.parseInt(id, 10), text: `特征 ${id}`, kind: 'limitation' }
}

/**
 * 构造一条针对被诉产品的映射行。
 * @param elementId - 要素 id。
 * @param mapping - 映射结论。
 * @returns 映射行。
 */
function row(elementId: string, mapping: Mapping): ChartRow {
  return {
    elementId,
    targetId: '产品A',
    quote: '引文',
    pinCite: '[产品A 图1]',
    mapping,
    state: mapping,
    verified: true,
  }
}

/** 全面覆盖金标语料（当前行为已符合预期的情形）。 */
export const ALL_ELEMENTS_CASES: readonly AllElementsCase[] = [
  {
    engine: 'all-elements',
    id: 'INF-001',
    title: '全部要素字面覆盖',
    rows: [row('1a', 'literal'), row('1b', 'literal')],
    elements: [element('1a'), element('1b')],
    targetId: '产品A',
    expected: { outcome: 'literal', literal: ['1a', '1b'], missing: [] },
  },
  {
    engine: 'all-elements',
    id: 'INF-002',
    title: '缺少一个要素即不落入保护范围',
    rows: [row('1a', 'literal'), row('1b', 'doe')],
    elements: [element('1a'), element('1b'), element('1c')],
    targetId: '产品A',
    expected: { outcome: 'not-covered', literal: ['1a'], missing: ['1c'] },
  },
  {
    engine: 'all-elements',
    id: 'INF-003',
    title: '无缺项但存在等同候选时需按等同判断',
    rows: [row('1a', 'literal'), row('1b', 'doe')],
    elements: [element('1a'), element('1b')],
    targetId: '产品A',
    expected: { outcome: 'equivalence-required', literal: ['1a'], missing: [] },
  },
  {
    engine: 'all-elements',
    id: 'INF-004',
    title: '字面覆盖依赖权利要求解释时降为构造依赖',
    rows: [row('1a', 'literal'), row('1b', 'literal-construction-dependent')],
    elements: [element('1a'), element('1b')],
    targetId: '产品A',
    expected: { outcome: 'construction-dependent', literal: ['1a'], missing: [] },
  },
  {
    engine: 'all-elements',
    id: 'INF-005',
    title: '要素表为空时不给实质结论',
    rows: [],
    elements: [],
    targetId: '产品A',
    expected: { outcome: 'undetermined', literal: [], missing: [] },
  },
  {
    engine: 'all-elements',
    id: 'INF-006',
    title: '任一权项被全部覆盖时整体结论取该权项',
    rows: [row('1a', 'not-found'), row('2a', 'literal'), row('2b', 'literal')],
    elements: [element('1a'), element('2a'), element('2b')],
    targetId: '产品A',
    expected: { outcome: 'literal', literal: ['2a', '2b'], missing: [] },
  },
  {
    engine: 'all-elements',
    id: 'INF-007',
    title: '低号权项覆盖更充分时整体结论取低号权项',
    rows: [row('1a', 'literal'), row('1b', 'literal'), row('2a', 'not-found')],
    elements: [element('1a'), element('1b'), element('2a')],
    targetId: '产品A',
    expected: { outcome: 'literal', literal: ['1a', '1b'], missing: [] },
  },
]
