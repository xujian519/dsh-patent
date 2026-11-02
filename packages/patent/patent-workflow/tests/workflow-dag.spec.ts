import { describe, expect, it } from 'vitest'
import {
  WorkflowError,
  manifestToFlowGraph,
  patentDisclosureManifest,
  patentNoveltyManifest,
  validateWorkflowManifest,
  validateWorkflowManifestDag,
  workflowManifestToMermaid,
  type WorkflowManifest,
} from '@deepseek-ai/dsh-patent-workflow'

/** rewindTo 指向后续阶段的 manifest：被"指向不存在的阶段"拦截（ids 顺序收集的隐含约束）。 */
const rewindForward: WorkflowManifest = {
  id: 'fwd_v1',
  name: '前向回退',
  caseType: 'test',
  stages: [
    { id: 'a', strategy: 'chain', description: 'A' },
    { id: 'b', strategy: 'chain', description: 'B', retry: { whenOutputMatches: '信号', rewindTo: 'c' } },
    { id: 'c', strategy: 'chain', description: 'C' },
  ],
}

describe('workflow manifest DAG bridge', () => {
  it('validateWorkflowManifest enforces rewindTo must point to an earlier stage', () => {
    expect(() => { validateWorkflowManifest(rewindForward) }).toThrow(WorkflowError)
    expect(() => { validateWorkflowManifest(rewindForward) }).toThrow(/rewindTo 指向不存在的阶段/)
  })

  it('validateWorkflowManifest accepts acyclic rewinds (builtin manifests)', () => {
    expect(() => { validateWorkflowManifest(patentNoveltyManifest) }).not.toThrow()
    expect(() => { validateWorkflowManifest(patentDisclosureManifest) }).not.toThrow()
  })

  it('validateWorkflowManifestDag reports no problems for builtin manifests', () => {
    expect(validateWorkflowManifestDag(patentNoveltyManifest)).toEqual([])
    expect(validateWorkflowManifestDag(patentDisclosureManifest)).toEqual([])
  })

  it('manifestToFlowGraph builds a schedulable DAG (topological levels)', () => {
    const graph = manifestToFlowGraph(patentDisclosureManifest)
    const levels = graph.topologicalLevels()
    const flat = levels.flat()
    expect(flat).toHaveLength(patentDisclosureManifest.stages.length)
    expect(new Set(flat).size).toBe(flat.length)
  })

  it('workflowManifestToMermaid renders sequential (solid) and rewind (dashed) edges', () => {
    const mermaid = workflowManifestToMermaid(patentDisclosureManifest)
    expect(mermaid.startsWith('flowchart TD')).toBe(true)
    expect(mermaid).toContain('preprocess --> eligibility')
    expect(mermaid).toContain('eligibility --> extract_problem')
    expect(mermaid).toContain('consistency -.-> extract_problem')
    expect(mermaid).toContain('review_gate["人工复核披露分析报告、权利要求特征表/从权树与说明书草案（中断等待确认）"]')
  })

  it('workflowManifestToMermaid renders plain chain for acyclic novelty manifest', () => {
    const mermaid = workflowManifestToMermaid(patentNoveltyManifest)
    expect(mermaid).toContain('parse --> time_baseline')
    expect(mermaid).toContain('time_baseline --> dispute-framing-refine')
    expect(mermaid).toContain('dispute-framing-refine --> generate_keywords')
    expect(mermaid).toContain('generate_keywords --> search')
    expect(mermaid).not.toContain('-.->')
  })

  it('workflowManifestToMermaid escapes quotes, backslashes and newlines in descriptions', () => {
    const manifest: WorkflowManifest = {
      id: 'escape_v1',
      name: '转义',
      caseType: 'test',
      stages: [
        { id: 'a', strategy: 'chain', description: '含 "双引号" 与 \\ 反斜杠' },
        { id: 'b', strategy: 'chain', description: '含\n换行' },
      ],
    }
    const mermaid = workflowManifestToMermaid(manifest)
    expect(mermaid).toContain('  a["含 \\"双引号\\" 与 \\\\ 反斜杠"]')
    expect(mermaid).toContain('  b["含\\n换行"]')
    expect(mermaid.split('\n')).toHaveLength(4)
  })

  it('sparse stage arrays skip the missing slots when building edges (no crash)', () => {
    // 数组按索引读取时含空洞，但迭代器只给出合法阶段：sequentialEdges 遇到
    // from/to 为 undefined 的相邻对时跳过，图与 Mermaid 都只包含真实阶段。
    const stageA: WorkflowManifest['stages'][number] = { id: 'a', strategy: 'chain', description: 'A' }
    const stageB: WorkflowManifest['stages'][number] = { id: 'b', strategy: 'chain', description: 'B' }
    const sparse = new Array<WorkflowManifest['stages'][number]>(3)
    sparse[0] = stageA
    sparse[2] = stageB
    Object.defineProperty(sparse, Symbol.iterator, {
      value: function* (): Generator<WorkflowManifest['stages'][number]> {
        yield stageA
        yield stageB
      },
    })
    const manifestSparse: WorkflowManifest = {
      id: 'sparse_v1',
      name: '稀疏',
      caseType: 'test',
      stages: sparse,
    }
    const graph = manifestToFlowGraph(manifestSparse)
    expect(graph.outgoing('a')).toEqual([])
    // 无顺序边 → 两个节点都是孤儿（这正是 hole 被跳过的可观测结果）。
    expect(validateWorkflowManifestDag(manifestSparse)).toEqual(['Orphan node: a', 'Orphan node: b'])

    const mermaid = workflowManifestToMermaid(manifestSparse)
    expect(mermaid).toContain('  a["A"]')
    expect(mermaid).toContain('  b["B"]')
    expect(mermaid).not.toContain('-->')
    expect(mermaid.split('\n')).toHaveLength(3)
  })
})
