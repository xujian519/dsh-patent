/**
 * `add_patent_figure_references` tool: 为既有 SVG 附图追加参考标号。
 *
 * 处理用户自己渲染/已有的流程图或框图（Graphviz 或同结构 SVG），按
 * label 文本匹配在 `<tspan>`/`<text>` 末尾追加 ` (numeral)`。用于
 * generate_patent_figure 之外的自有图或旧图补标号；标号体系与主工具
 * 一致（每图 100 系列，跨图同件同号）。移植自 Claude-Patent-Creator
 * 的 add_reference_numbers（MIT）。
 * @module @deepseek-ai/dsh-patent-tools/tool/add-patent-figure-references
 */

import { writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { SvgAnnotateError, annotateSvg } from '../figure/svg-annotate.ts'
import { annotateSvgWithLeaderLines } from '../figure/leader-line.ts'
import { figureWordingWarnings } from '../figure/wording-rules.ts'
import type { FigureNumeralItem, NumeralMergeConflict } from '../figure/numeral-store.ts'
import { registerFigureNumerals } from './figure-output.ts'
import { SVG_PATH_PARAM, SVG_PATH_RESULT_FIELDS, readSvgInput } from './internal/svg-input.ts'
import type { SvgAnnotateReference } from '../figure/svg-annotate.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'

/** 依赖注入。cwd 为路径基准，默认 process.cwd()。 */
export type AddPatentFigureReferencesDeps = {
  /** 工作目录（缺省 process.cwd()）。 */
  cwd?: string
  /** 可选读取作用域标号表（`figure_family` 即作用域），用于补全调用方未给出的标号。 */
  loadNumerals?: (scope: string) => Promise<FigureNumeralItem[]>
  /** 可选合并写入作用域标号表；登记调用方本次显式给出的标号。 */
  upsertNumerals?: (scope: string, items: readonly FigureNumeralItem[]) => Promise<NumeralMergeConflict[]>
  /** 引线标号净距（毫米，Config.figureLeaderClearanceMm）。 */
  leaderClearanceMm?: number
  /** 引线放置冲突时的外推步长（毫米，Config.figureLeaderPushStepMm）。 */
  leaderPushStepMm?: number
  /** 引线外推距离上限（毫米，Config.figureLeaderPushLimitMm）。 */
  leaderPushLimitMm?: number
}

/** 输入：SVG 路径 + 参考标号表。 */
export type AddPatentFigureReferencesInput = {
  /** SVG 图片路径（工作区相对或绝对路径）。 */
  svg_path: string
  /** 参考标号（label 匹配图内文本；未命中项进 warnings）。 */
  references: SvgAnnotateReference[]
  /** 输出文件名（不含扩展名，仅单个文件名、不含目录，默认 <原名>_annotated）。 */
  output_filename?: string
  /** true 时改用引线模式：标号置于组件外侧并以引线相连；默认 false 内嵌「 (标号)」。 */
  leader_lines?: boolean
  /** 标号作用域（与 generate_patent_figure 的 figure_family 同义）：给出时用标号表补全 references，并登记本次给出的标号。 */
  figure_family?: string
}

/** 输出：标注后路径 + 未命中警告。 */
export type AddPatentFigureReferencesOutput = {
  /** 标注后的 SVG 路径（工作区相对）。 */
  path: string
  /** 标注后的 SVG 绝对路径（输出落在输入文件旁，可能不在工作区内）。 */
  absolutePath: string
  /** 参考数。 */
  numReferences: number
  /** 未命中任何文本元素的参考 label（原文顺序）。 */
  warnings: string[]
}

const DESCRIPTION = [
  '为已有 SVG 附图追加专利参考标号：按组件文本匹配标注，输出 *_annotated.svg（不改动原图）。默认在匹配文本末尾内嵌「 (标号)」；leader_lines=true 时改用引线模式，标号置于组件外侧并以引线相连（仅 Graphviz/同构节点组 SVG 支持）。用户提供了自绘流程图/框图或已渲染 SVG，需要补标记、与说明书标号对齐时使用。',
  '',
  '匹配规则：子串匹配（大小写不敏感）；每个文本元素至多命中一个参考；同名组件出现在多个位置时全部同号标注；未命中的参考列为警告返回。',
  '',
  '标号形式：非阿拉伯数字标号（如 S101）按《专利审查指南》第一部分第一章 4.3「附图标记应当使用阿拉伯数字编号」返回警告（照常标注）。',
  '',
  '引线模式：标号置于组件轮廓外侧，引线避开图内已绘的边线与箭头，并在越出画布时扩展画布使之完整可见；无可放置位置或缺轮廓时退化为内嵌标号并警告。',
  '',
  '标号作用域：给出 figure_family 时，用该作用域已有的附图标记表补全 references 未列出的部件（调用方给出的标签优先），并把本次给出的标号登记进表；不给出时行为不变——纯回填，不读写标号表。',
  '',
  '可重复执行：对已标注的 SVG 再次标注时，先移除上一次写入的引线组与命中文本尾部的内嵌标号，不会叠加或重复编号。',
].join('\n')

/**
 * Build the `add_patent_figure_references` tool.
 * @param deps - optional cwd.
 * @returns a registry-ready tool definition.
 */
export function createAddPatentFigureReferencesTool(deps: AddPatentFigureReferencesDeps = {}): ToolDefinition {
  return defineTool({
    name: 'add_patent_figure_references',
    description: DESCRIPTION,
    parameters: {
      svg_path: SVG_PATH_PARAM,
      references: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: '图内组件文本（子串匹配）' },
            numeral: { type: 'string', required: true, description: '参考标号（如 20、101）' },
          },
        },
        description: '参考标号表',
      },
      output_filename: { type: 'string', description: '输出文件名（不含扩展名，默认 <原名>_annotated）' },
      leader_lines: { type: 'boolean', description: 'true 时改用引线模式（标号置于组件外侧并以引线相连）；默认 false 内嵌「 (标号)」' },
      figure_family: {
        type: 'string',
        description: '标号作用域（与 generate_patent_figure 的 figure_family 同义）：给出时用附图标记表补全 references 未列出的部件，并把本次给出的标号登记进表',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SVG_PATH_RESULT_FIELDS,
          numReferences: { type: 'integer', required: true },
          warnings: WARNINGS_SCHEMA,
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [`已生成标注 SVG：${value.path}`, `绝对路径：${value.absolutePath}`, `参考标号：${value.numReferences}`, ...warningSection(value.warnings, '未命中')].join('\n'),
        },
      ],
    },
    async execute(args) {
      const cwd = deps.cwd ?? process.cwd()
      const { absolutePath: absPath, svg } = await readSvgInput(args.svg_path, cwd, 'add_patent_figure_references')
      const tableWarnings: string[] = []
      const references = await resolveReferences(args, deps, tableWarnings)
      let result
      try {
        result = args.leader_lines === true
          ? annotateSvgWithLeaderLines(svg, references, {
            ...(deps.leaderClearanceMm === undefined ? {} : { clearanceMm: deps.leaderClearanceMm }),
            ...(deps.leaderPushStepMm === undefined ? {} : { pushStepMm: deps.leaderPushStepMm }),
            ...(deps.leaderPushLimitMm === undefined ? {} : { pushLimitMm: deps.leaderPushLimitMm }),
          })
          : annotateSvg(svg, references)
      } catch (error) {
        /* v8 ignore start -- annotateSvg only throws SvgAnnotateError; the rethrow keeps unknown failures loud */
        if (error instanceof SvgAnnotateError) {
          throw new PatentToolError('invalid_tool_input', `SVG 标注被拒：${error.message}`, { tool: 'add_patent_figure_references' })
        }
        throw error
        /* v8 ignore stop */
      }
      const dir = resolve(absPath, '..')
      const base = args.output_filename ?? `${baseName(absPath)}_annotated`
      const outPath = resolveOutputPath(dir, base)
      await writeFile(outPath, result.svg, 'utf8')
      // 图面用语检查：标号由调用方给出，非阿拉伯数字标号违反指南 4.3。
      const warnings = [
        ...result.warnings,
        ...figureWordingWarnings([], references.map(reference => reference.numeral)),
        ...tableWarnings,
      ]
      // 只登记调用方显式给出的标号：表内既有项不是本次新增的事实。
      await registerFigureNumerals(deps.upsertNumerals, args.figure_family, {
        numeralMap: args.references.map(reference => ({
          componentId: reference.label,
          label: reference.label,
          numeral: reference.numeral,
        })),
        warnings,
      })
      return { path: relative(cwd, outPath), absolutePath: outPath, numReferences: references.length, warnings }
    },
  })
}

/**
 * 合并调用方给出的标号与标号表中尚未列出的部件。
 *
 * 表只读：调用方给出的标签优先，表里同标签的项被忽略；读取失败时退回调用方的
 * 清单并记警告，而不是退化成「没有标号」。
 * @param args - 工具输入。
 * @param deps - 工具依赖。
 * @param warnings - 表读取失败的警告去处。
 * @returns 用于标注的标号清单。
 */
async function resolveReferences(
  args: AddPatentFigureReferencesInput,
  deps: AddPatentFigureReferencesDeps,
  warnings: string[],
): Promise<SvgAnnotateReference[]> {
  if (args.figure_family === undefined || deps.loadNumerals === undefined) return [...args.references]
  let table: FigureNumeralItem[]
  try {
    table = await deps.loadNumerals(args.figure_family)
  } catch (error) {
    warnings.push(`读取附图标记表失败：${error instanceof Error ? error.message : String(error)}；本次只用调用方给出的标号`)
    return [...args.references]
  }
  const given = new Set(args.references.map(reference => reference.label))
  const appended = table
    .filter(item => item.label.trim() !== '' && !given.has(item.label))
    .map(item => ({ label: item.label, numeral: item.numeral }))
  return [...args.references, ...appended]
}

/** 提取文件名（不含扩展名）。 */
function baseName(path: string): string {
  const name = basename(path)
  return name.endsWith('.svg') ? name.slice(0, -4) : name
}

/**
 * 解析输出路径：`output_filename` 是模型输入，必须解析为图目录内的单个文件。
 * 名称检查挡分隔符与 `.`/`..`；包含性检查是最终不变量，同时覆盖 Windows 盘符
 * 相对名（`C:evil`）这类平台特有的名称语义。
 * 不用 {@link sanitizeDotFilename} 净化：它会替换 `[^\w\-]`，把中文附图名静默改名。
 * @param dir - 输入 SVG 所在目录（绝对路径）。
 * @param base - 输出文件名（不含扩展名）。
 * @returns 输出 SVG 的绝对路径。
 * @throws PatentToolError 名称为空、为 `.`/`..`、含路径分隔符或 NUL，或解析结果越出 dir。
 */
function resolveOutputPath(dir: string, base: string): string {
  const notASingleName = base.trim() === '' || base === '.' || base === '..'
    || base.includes('/') || base.includes('\\') || base.includes('\0')
  if (notASingleName) {
    throw new PatentToolError('invalid_tool_input', `output_filename 必须是单个文件名（不含目录）：${base}`, { tool: 'add_patent_figure_references' })
  }
  const outPath = resolve(dir, `${base}.svg`)
  const rel = relative(dir, outPath)
  /* v8 ignore start -- the name checks above reject separators, dots and NUL, so the resolved file stays inside dir */
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PatentToolError('invalid_tool_input', `output_filename 越出图目录：${base}`, { tool: 'add_patent_figure_references' })
  }
  /* v8 ignore stop */
  return outPath
}
