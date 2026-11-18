/**
 * patent workflow ↔ 通用 DAG 引擎的桥接层（方案 A：借用能力，不换执行路径）。
 *
 * 借用点：
 * - FlowGraph 建图：manifest stages 的顺序执行链（DAG）
 * - FlowGraph.validate() / detectCycle() / topologicalLevels()：静态校验与拓扑分层
 * - Mermaid 可视化：输出格式对齐 FlowGraph.formatMermaid，回退边用虚线区分
 *
 * 注意：retry.rewindTo 回退边不加入 FlowGraph 依赖边——顺序边前进 + 回退边后退
 * 构成的混合环是合法的受控回退（runWorkflow 的 rewindCounts 有界执行），
 * 若入图会被 detectCycle 误报为死循环环。回退边仅作为标注出现在 Mermaid 虚线中。
 */

import { FlowGraph, type FlowNodeType } from './flow-graph.ts'
import type { WorkflowManifest, WorkflowStage, WorkflowStrategy } from '@deepseek-ai/dsh-patent-core'

/** 阶段 → FlowNodeType 映射：审批门为 human-approval，声明 atom 的为 tool，其余为 agent。 */
function nodeTypeFor(stage: { strategy: WorkflowStrategy; atom?: string }): FlowNodeType {
  if (stage.atom === 'approval-gate') return 'human-approval'
  if (stage.atom !== undefined) return 'tool'
  return 'agent'
}

/** 返回相邻阶段对（顺序边）；跳过 noUncheckedIndexedAccess 下可能为 undefined 的元素。 */
function sequentialEdges(stages: readonly WorkflowStage[]): Array<{ from: WorkflowStage; to: WorkflowStage }> {
  const edges: Array<{ from: WorkflowStage; to: WorkflowStage }> = []
  for (let i = 0; i + 1 < stages.length; i += 1) {
    const from = stages[i]
    const to = stages[i + 1]
    if (from === undefined || to === undefined) continue
    edges.push({ from, to })
  }
  return edges
}

/**
 * 用 FlowGraph 构建 manifest 的执行链图：仅顺序边（依赖边），回退边不入图。
 * 返回的图是严格 DAG，可安全用于 topologicalLevels / validate。
 * 包外调用方可直接取用；仓内消费方目前只有测试。
 * @public
 * @param manifest - 工作流清单。
 * @returns 顺序执行链的 FlowGraph。
 */
export function manifestToFlowGraph(manifest: WorkflowManifest): FlowGraph {
  const graph = new FlowGraph()
  for (const stage of manifest.stages) {
    graph.addNode({ id: stage.id, type: nodeTypeFor(stage), name: stage.description })
  }
  for (const { from, to } of sequentialEdges(manifest.stages)) {
    graph.addEdge({ from: from.id, to: to.id })
  }
  return graph
}

/**
 * 用 FlowGraph 静态校验 manifest 顺序链图（环 / 孤儿节点）。
 * 顺序链是严格 DAG，正常返回空数组；返回问题列表 = 图不合法。
 * 包外调用方免去先构造图的公开便利入口；仓内消费方目前只有测试。
 * @public
 * @param manifest - 工作流清单。
 * @returns 图问题列表（环 / 孤儿节点），合法时为空数组。
 */
export function validateWorkflowManifestDag(manifest: WorkflowManifest): string[] {
  return manifestToFlowGraph(manifest).validate()
}

/** 转义 Mermaid 字符串字面量中的反斜杠、引号与换行，避免破坏语法。 */
function escapeName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')
}

/**
 * Mermaid 可视化：顺序边实线 -->，retry 回退边虚线 -.-&gt;。
 * 格式对齐 FlowGraph.formatMermaid（flowchart TD）。
 * @param manifest - 工作流清单。
 * @returns flowchart TD 格式的 Mermaid 源码。
 */
export function workflowManifestToMermaid(manifest: WorkflowManifest): string {
  const lines = ['flowchart TD']
  for (const stage of manifest.stages) {
    lines.push(`  ${stage.id}["${escapeName(stage.description)}"]`)
  }
  for (const { from, to } of sequentialEdges(manifest.stages)) {
    lines.push(`  ${from.id} --> ${to.id}`)
  }
  const stageIds = new Set(manifest.stages.map(s => s.id))
  for (const stage of manifest.stages) {
    if (stage.retry?.rewindTo !== undefined && stageIds.has(stage.retry.rewindTo)) {
      lines.push(`  ${stage.id} -.-> ${stage.retry.rewindTo}`)
    }
  }
  return lines.join('\n')
}
