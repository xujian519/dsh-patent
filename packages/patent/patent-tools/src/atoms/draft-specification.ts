/**
 * 撰写域原子：draft-specification（确定性说明书草稿）。
 *
 * 包装既有的 `draftSpecification`：把工作流状态里的技术方案、技术问题、有益效果、
 * 实施例与附图说明组装成五部分说明书草案，供 `spec-check mode=spec` 执行
 * A26.3/A26.4 检查。不调用模型；缺技术方案时降级，缺可选字段时保留撰写指引占位。
 */

import {
  degraded,
  getStateArray,
  type Atom,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
} from '@deepseek-ai/dsh-patent-core'
import {
  draftSpecification,
  renderDraftSpecification,
  type DraftSpecificationInput,
} from '../tool/draft-specification.ts'
import type { SpecFigureMark } from '../tool/spec-blocks.ts'
import { firstStateString, resolvePatentType, resolveTechDomain } from './state-values.ts'

/** draft-specification 原子：从工作流状态生成五部分说明书草案。 */
export const draftSpecificationAtom: Atom = {
  name: 'draft-specification',
  description: '生成说明书草案与摘要（技术领域/背景技术/发明内容/具体实施方式，有附图时含附图说明，确定性）：读取技术方案、问题、效果、实施例、PFIE 特征与附图分析，按实施例标题切分具体实施方式并复核每块原文锚点，标注命中的特征编号（F1、F2…）与附图标记；未命中原文的块整块丢弃并报告，输出 ≤300 字摘要、完整度与缺失章节，供 spec-check 的 spec 模式检查 A26.3/A26.4',
  category: 'extract',
  inputSchema: [
    'title',
    'invention_title',
    'source_text',
    'text',
    'input',
    'problems',
    'effects',
    'technical_problem',
    'beneficial_effects',
    'background',
    'embodiments',
    'features',
    'figure_analysis',
    'drawing_descriptions',
    'tech_domain',
    'patent_type',
    'has_drawings',
  ],
  // title/patent_type 是调用方输入：同名键不能声明为输出，否则阶段回退清理会先删掉输入。
  outputSchema: [
    'specification',
    'abstract',
    'embodiment_blocks',
    'dropped_embodiment_blocks',
    'draft_specification_warnings',
    'draft_title',
    'draft_patent_type',
    'complete',
    'missing_inputs',
  ],
}

/**
 * 读取字符串数组，丢弃非字符串与空项。
 * @param state - 阶段执行态。
 * @param key - 数组键。
 * @returns 非空字符串项。
 */
function stringList(state: PipelineState, key: string): string[] {
  const values: string[] = []
  for (const value of getStateArray(state, key)) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text.length > 0) values.push(text)
  }
  return values
}

/**
 * 读取 `figure_analysis` 中可用的附图标记；图号缺省按数组序号加一。
 *
 * 该键来自上游 stage 的共享状态，读取时按状态边界窄化：不可用图、缺失图号与
 * 非法组件都跳过，不把畸形项写进实施例引用。
 * @param state - 阶段执行态。
 * @returns 去重后的附图标记。
 */
function readFigureMarks(state: PipelineState): SpecFigureMark[] {
  const marks: SpecFigureMark[] = []
  const seen = new Set<string>()
  for (const [index, entry] of getStateArray(state, 'figure_analysis').entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (record['usable'] === false) continue
    const rawNumber = record['figureNumber']
    const figureNumber = typeof rawNumber === 'number' && Number.isInteger(rawNumber) && rawNumber > 0
      ? rawNumber
      : index + 1
    const components = Array.isArray(record['components']) ? record['components'] : []
    for (const component of components) {
      if (component === null || typeof component !== 'object' || Array.isArray(component)) continue
      const rawRef = (component as Record<string, unknown>)['refNumber']
      if (typeof rawRef !== 'string') continue
      const refNumber = rawRef.trim()
      if (refNumber.length === 0) continue
      const key = `${figureNumber}\u0000${refNumber}`
      if (seen.has(key)) continue
      seen.add(key)
      marks.push({ figure_number: figureNumber, ref_number: refNumber })
    }
  }
  return marks
}

/**
 * 解析发明名称：显式标题优先；否则取原文首行，过长或为空时用通用名称。
 * @param state - 阶段执行态。
 * @returns 发明名称。
 */
function resolveTitle(state: PipelineState): string {
  const explicit = firstStateString(state, ['title', 'invention_title'])
  if (explicit.length > 0) return explicit
  /* v8 ignore start -- firstStateString returns a non-blank string, so one line is non-empty */
  const firstLine = firstStateString(state, ['source_text', 'text', 'input'])
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''
  /* v8 ignore stop */
  const candidate = firstLine.replace(/^#{1,6}\s*/, '')
  return candidate.length > 0 && candidate.length <= 25 ? candidate : '技术方案'
}

/** draft-specification 执行器：组装说明书草案并写入 `specification`。 */
export class DraftSpecificationHandler implements StageHandler {
  readonly name = 'draft-specification'
  readonly category = 'extract' as const

  /**
   * 执行说明书草稿阶段。
   * @param input - 阶段执行输入（state 携带技术方案与可选分析结果）。
   * @returns 下一管线状态：说明书草案文本与撰写警告。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const solution = firstStateString(state, ['source_text', 'text', 'input'])
    if (solution.length === 0) {
      return degraded('draft-specification', '输入为空（state.source_text / text / input）')
    }

    const problems = stringList(state, 'problems')
    const effects = stringList(state, 'effects')
    const embodiments = stringList(state, 'embodiments')
    const features = stringList(state, 'features')
    const figureMarks = readFigureMarks(state)
    const drawingDescriptions = stringList(state, 'drawing_descriptions')
    const problem = firstStateString(state, ['technical_problem', 'problem']) || problems.join('；')
    const beneficialEffects = firstStateString(state, ['beneficial_effects', 'effects']) || effects.join('；')
    const background = firstStateString(state, ['background'])
    const techDomain = resolveTechDomain(state)
    const patentType = resolvePatentType(state)
    const draftInput: DraftSpecificationInput = {
      title: resolveTitle(state),
      technical_solution: solution,
      source_text: solution,
      has_drawings: state['has_drawings'] === true,
      ...(embodiments.length > 0 ? { embodiments } : {}),
      ...(features.length > 0 ? { features } : {}),
      ...(figureMarks.length > 0 ? { figure_marks: figureMarks } : {}),
      ...(problem.length > 0 ? { technical_problem: problem } : {}),
      ...(beneficialEffects.length > 0 ? { beneficial_effects: beneficialEffects } : {}),
      ...(background.length > 0 ? { background } : {}),
      ...(drawingDescriptions.length > 0 ? { drawing_descriptions: drawingDescriptions } : {}),
      ...(techDomain !== undefined ? { tech_domain: techDomain } : {}),
      ...(patentType !== undefined ? { patent_type: patentType } : {}),
    }
    const draft = draftSpecification(draftInput)
    return {
      specification: renderDraftSpecification(draft),
      abstract: draft.abstract,
      embodiment_blocks: draft.embodiment_blocks,
      dropped_embodiment_blocks: draft.dropped_embodiment_blocks,
      draft_specification_warnings: draft.warnings,
      draft_title: draft.title,
      draft_patent_type: draft.patent_type,
      complete: draft.complete,
      missing_inputs: draft.missing_inputs,
    }
  }
}
