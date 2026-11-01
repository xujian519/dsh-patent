/**
 * `generate_patent_figure` 的 DOT 构建与渲染后标注：把归一后的结构化输入交给 dot-builder
 * 的图型函数，并在渲染产物落盘后读回做引线标号标注。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-render-plan
 */

import { readFile, writeFile } from 'node:fs/promises'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  buildBlockDiagramDOT,
  buildComponentHierarchyDOT,
  buildFlowchartDOT,
  buildStateDiagramDOT,
  DotBuildError,
  findFileReferenceAttribute,
  getDiagramTemplate,
  resolvePageBundle,
} from '../figure/dot-builder.ts'
import type { HierarchyNode } from '../figure/dot-builder.ts'
import { annotateSvgWithLeaderLines } from '../figure/leader-line.ts'
import { SvgAnnotateError } from '../figure/svg-annotate.ts'
import { RAW_DOT_MAX_BYTES, STRUCTURAL_MAX_ITEMS } from './figure-input.ts'
import type { DotFigureType, StructuralFigureInput } from './figure-input.ts'

/**
 * 读回渲染 SVG 做引线标注并写回；安全校验失败降级为警告（图已生成，不吞工件）。
 * @param outcomePath - 渲染产物路径，原地改写。
 * @param references - 标号与组件名，供引线选择落点。
 * @param warnings - 收集提示的警告数组。
 */
export async function annotateRenderedSvg(
  outcomePath: string,
  references: readonly { label: string; numeral: string }[],
  warnings: string[],
): Promise<void> {
  try {
    const rendered = await readFile(outcomePath, 'utf8')
    const annotated = annotateSvgWithLeaderLines(rendered, references)
    if (annotated.svg !== rendered) await writeFile(outcomePath, annotated.svg, 'utf8')
    warnings.push(...annotated.warnings.map(w => `引线标注：${w}`))
  } catch (error) {
    if (error instanceof SvgAnnotateError) {
      warnings.push(`引线标注被跳过：${error.message}`)
    } else {
      throw error
    }
  }
}

/** 单图 DOT 构建参数（主路径与面板路径共用）。 */
type FigureDotParams = {
  figureNumber: number
  numeralsForBuilder: Record<string, string>
  numeralStep?: number | undefined
  style: 'grayscale' | 'semantic'
  fontName: string
  /** 部署图面字号换算出的 DOT pt 值（小四 = 12pt）；缺省不设，DOT 用历史默认。 */
  fontPt: number | undefined
  pageBundle: ReturnType<typeof resolvePageBundle>
  leaderLinesActive: boolean
}

/** 单图 DOT 构建共用选项（flowchart/block/hierarchy 共用数值/样式/页面/引线开关）。 */
function buildDotOptions(params: FigureDotParams) {
  const { figureNumber, numeralsForBuilder, numeralStep, style, fontName, fontPt, pageBundle, leaderLinesActive } = params
  return {
    figureNumber,
    numerals: numeralsForBuilder,
    ...(numeralStep === undefined ? {} : { numeralStep }),
    style,
    fontName,
    ...(fontPt === undefined ? {} : { fontPt }),
    ...(pageBundle === undefined ? {} : { page: pageBundle }),
    ...(leaderLinesActive ? { embedNumerals: false } : {}),
  }
}

/** 层级树节点数（任意深度）。 */
function countHierarchyNodes(nodes: readonly HierarchyNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countHierarchyNodes(node.children ?? []), 0)
}

/**
 * 结构化输入的图元素总数（节点 + 边；流程步骤内联节点与层级树递归计入）。
 * @param input - 已归一的单图结构化输入。
 * @returns 图元素总数；`raw_dot`/`template` 由调用方自带内容，计 0。
 */
function countFigureItems(input: StructuralFigureInput & { figure_type: DotFigureType }): number {
  switch (input.figure_type) {
    case 'flowchart': {
      const inline = input.steps.flatMap(step => step.next.filter(next => typeof next !== 'string'))
      const edges = input.steps.reduce((sum, step) => sum + step.next.length, 0)
      return input.steps.length + inline.length + edges
    }
    case 'state_diagram':
      return input.states.length + input.transitions.length
    case 'block_diagram':
      return input.blocks.length + input.connections.length
    case 'component_hierarchy': {
      const nodes = countHierarchyNodes(input.tree)
      return nodes + Math.max(0, nodes - 1)
    }
    case 'raw_dot':
    case 'template':
      return 0
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new figure type here. */
    default:
      return assertNever(input.figure_type, 'structural figure input')
  }
}

/**
 * 构建单图 DOT（单图与面板共用）。
 * @param input - 已归一的单图结构化输入，图型限于 DOT 图型。
 * @param params - 图号、标号、风格、字体与页面/引线开关。
 * @returns DOT 文本，可直接交渲染器。
 * @throws DotBuildError 输入为空、超出元素上限或含文件引用属性时；由调用方映射为工具错误。
 */
export function buildFigureDot(input: StructuralFigureInput & { figure_type: DotFigureType }, params: FigureDotParams): string {
  const { figureNumber, style, fontName, pageBundle, leaderLinesActive } = params
  const items = countFigureItems(input)
  if (items > STRUCTURAL_MAX_ITEMS) {
    throw new DotBuildError('too_large', `图元素过多（${items} 个 > 上限 ${STRUCTURAL_MAX_ITEMS}）：请减少元素或拆分到 panels 多面板`)
  }
  switch (input.figure_type) {
    case 'flowchart': {
      if (input.steps.length === 0) {
        throw new DotBuildError('empty_input', 'flowchart 需要 steps')
      }
      return buildFlowchartDOT(input.steps, buildDotOptions(params))
    }
    case 'state_diagram': {
      if (input.states.length === 0) {
        throw new DotBuildError('empty_input', 'state_diagram 需要 states')
      }
      return buildStateDiagramDOT(input.states, input.transitions, buildDotOptions(params))
    }
    case 'block_diagram': {
      if (input.blocks.length === 0) {
        throw new DotBuildError('empty_input', 'block_diagram 需要 blocks')
      }
      return buildBlockDiagramDOT(input.blocks, input.connections, buildDotOptions(params))
    }
    case 'component_hierarchy': {
      if (input.tree.length === 0) {
        throw new DotBuildError('empty_input', 'component_hierarchy 需要 tree')
      }
      return buildComponentHierarchyDOT(input.tree, buildDotOptions(params))
    }
    case 'template': {
      if (input.template === undefined) {
        throw new DotBuildError('invalid_template', 'template 模式需要 template 名')
      }
      return getDiagramTemplate(input.template, {
        figureNumber,
        style,
        fontName,
        ...(pageBundle === undefined ? {} : { page: pageBundle }),
        ...(leaderLinesActive ? { embedNumerals: false } : {}),
      })
    }
    case 'raw_dot': {
      if (input.dot === undefined || input.dot.trim() === '') {
        throw new DotBuildError('empty_input', 'raw_dot 需要 dot 内容')
      }
      if (input.dot.length > RAW_DOT_MAX_BYTES) {
        throw new DotBuildError('too_large', `raw_dot 输入过大（>${RAW_DOT_MAX_BYTES} 字节）`)
      }
      const fileReference = findFileReferenceAttribute(input.dot)
      if (fileReference !== undefined) {
        throw new DotBuildError(
          'file_reference',
          `raw_dot 含文件引用属性 ${fileReference}=：附图必须自包含，DOT 不得引用宿主文件（如需在图上表达图像内容，请改用图形/文字要素绘制）`,
        )
      }
      return input.dot
    }
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new figure type here. */
    default:
      return assertNever(input.figure_type, 'structural figure input')
  }
}
