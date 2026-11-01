/**
 * `recognize_chemical_structure` tool: extract chemical structures (SMILES
 * candidates, molecular formula, compound names) from an image or document
 * text. Ported from Sati's recognizeChemicalStructure.ts.
 *
 * The Sati chemistry ENGINE (src/patent/chemistry/*: VLM image analysis, text
 * regex + LLM name→SMILES, RDKit validation) was not ported into any dsh
 * package. RDKit is an optional native dependency and is NOT installed in dsh.
 * The tool therefore ports the wrapper (input/output schema, description,
 * render) and returns a canonical "unavailable" result (soft outcome) instead
 * of performing recognition — see the Known Limitations note in the report.
 * @module @deepseek-ai/dsh-patent-tools/tool/recognize-chemical-structure
 */

import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import type { ChemistryIndexEntry } from '../chemistry/index-store.ts'
import { WARNINGS_SCHEMA } from './internal/tool-output.ts'

/** 化学实体识别类型。 */
const CHEMICAL_KINDS = ['formula', 'structure', 'markush'] as const

/** Chemical entity kind (formula / structure / Markush). */
type ChemicalKind = (typeof CHEMICAL_KINDS)[number]

/** Recognition mode (image / text / auto). */
type RecognizeChemicalStructureMode = 'image' | 'text' | 'auto'

/** Input for the recognize_chemical_structure tool. */
export type RecognizeChemicalStructureInput = {
  /** 化学结构图图片路径（工作区相对或绝对路径；PDF 页请先经附件解析导出图片）。 */
  image_path?: string
  /** 文档文本（说明书/权利要求片段；或单独的化合物名称）。 */
  text?: string
  /** 识别模式：image 走图片两步法；text 走文本三级流水线；auto 按输入分派（默认）。 */
  mode?: RecognizeChemicalStructureMode
  /** 权利要求/技术方案上下文（图文对齐，可选）。 */
  claim_context?: string
}

/** 单条 SMILES 候选（VLM/文本提取产物，经 RDKit 校验）。 */
export type ChemicalSmilesCandidate = {
  /** 原始 SMILES（模型/提取器输出，未经规范化）。 */
  smiles: string
  /** RDKit 规范化后的 SMILES（仅 valid 时存在）。 */
  canonicalSmiles?: string
  /** 候选置信度 0-1。 */
  confidence: number
  /** 是否通过校验（RDKit 确认结构合法）。 */
  valid: boolean
  /** 校验失败原因（仅 valid=false 时存在）。 */
  validationError?: string
}

/**
 * 化学式识别结果。
 *
 * 防幻觉约定（评审 H1）：`usable` 表示存在合法且置信度达标的候选；
 * `needHumanReview` 表示全部候选非法、置信度不足或 RDKit 不可用（未验证），
 * 上层应进入人工确认流程而非直接采信。
 */
export type ChemicalStructureResult = {
  /** 识别来源：图片路径（工作区相对路径）。 */
  imagePath?: string
  /** 识别来源：输入文本（文本/名称模式）。 */
  sourceText?: string
  /** 识别类型。 */
  kind: ChemicalKind
  /** 多候选 SMILES（模型输出顺序）。 */
  candidates: ChemicalSmilesCandidate[]
  /** 选定候选在 candidates 中的下标（-1 表示未选定）。 */
  chosenIndex: number
  /** 选定候选的规范化 SMILES。 */
  canonicalSmiles?: string
  /** 分子式。 */
  formula?: string
  /** 化合物名称（模型输出/文本提取）。 */
  names: string[]
  /** 整体置信度 0-1。 */
  confidence: number
  /** 警告（识别降级原因、校验失败、需人工确认等）。 */
  warnings: string[]
  /** 是否需人工复核（RDKit 不可用即未验证）。 */
  needHumanReview: boolean
  /** 是否可直接使用。 */
  usable: boolean
  /** 实际使用的模型标识。 */
  modelUsed: string
}

/** 化学识别引擎未接入时的警告文案（模型可见）。 */
const UNAVAILABLE_WARNING = '化学识别引擎未接入（VLM 两步法 + name→SMILES + RDKit 校验为后续工作），本次未执行识别。'

const DESCRIPTION = [
  '识别化学式/化学结构：从化学结构图（图片模式，多模态模型两步分析 + RDKit 校验）或文档文本（文本模式，正则候选 → LLM 复核/化合物名称转 SMILES → RDKit 校验）中提取多候选 SMILES、分子式与化合物名称。当交底书/说明书/权利要求含化学结构式（含 Markush 广义结构）、分子式或化合物名称需要转 SMILES 时使用。注意：本工具不直接解析 PDF——图片模式输入须为已导出的图片（jpeg/png/gif/webp），文本模式可传 PDF 文本层提取结果。',
  '',
  '本构建未接入化学识别引擎：识别流水线（VLM 两步法、name→SMILES、RDKit 校验）属后续工作，调用返回 needHumanReview=true 的不可用结果。需要化学结构解析时改走人工复核或外部工具链，不要靠本工具产出 SMILES。',
].join('\n')
/**
 * Render the canonical chemistry result into model-facing prose.
 * @param value - the chemistry recognition result to render.
 * @returns the rendered prose.
 */
export function renderChemicalStructure(value: ChemicalStructureResult): string {
  if (!value.usable) {
    return `化学结构识别不可用：${value.warnings.join('；') || '未知原因'}`
  }
  const lines = [`化学结构识别结果（${value.kind}，置信度 ${value.confidence.toFixed(2)}）`]
  if (value.names.length > 0) lines.push(`名称：${value.names.join('、')}`)
  if (value.formula) lines.push(`分子式：${value.formula}`)
  if (value.canonicalSmiles) lines.push(`规范化 SMILES：${value.canonicalSmiles}`)
  if (value.candidates.length > 0) {
    lines.push('', '候选：', ...value.candidates.map(c => `- ${c.smiles}（${c.valid ? 'valid' : 'invalid'}${c.validationError ? '：' + c.validationError : ''}，置信度 ${c.confidence.toFixed(2)}）`))
  }
  if (value.warnings.length > 0) lines.push('', '警告：', ...value.warnings.map(w => `- ${w}`))
  if (value.needHumanReview) lines.push('', '⚠️ 需人工复核后再采信。')
  return lines.join('\n')
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    smiles: { type: 'string', required: true },
    canonicalSmiles: { type: 'string' },
    confidence: { type: 'number', required: true },
    valid: { type: 'boolean', required: true },
    validationError: { type: 'string' },
  },
} as const

/** Injected chemistry-recognition dependencies. */
export type RecognizeChemicalStructureDeps = {
  /**
   * Persist a usable recognition into the chemistry index
   * (chemistryIndexStore.upsert). Optional enhancement: a throwing upsert is
   * swallowed so the recognition result still returns.
   */
  upsertIndex?: (entry: ChemistryIndexEntry) => Promise<void>
}

/** 文本来源索引键：`text:<sha256 前缀>`。 */
function textSourceKey(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return `text:${hash}`
}

/**
 * 化学索引来源键：图片模式用图片路径，文本模式用 `text:<hash>`（与 Sati 一致）。
 * @param args - 识别工具输入。
 * @returns 来源标识（sourceKey）。
 */
export function resolveChemicalSourceKey(args: { image_path?: string; text?: string }): string {
  return args.image_path !== undefined ? args.image_path : textSourceKey(args.text ?? '')
}

/**
 * Build the `recognize_chemical_structure` tool.
 *
 * The full chemistry pipeline (VLM image analysis, LLM name→SMILES, RDKit
 * validation) is not ported: RDKit is only one of its missing pieces, so
 * execute returns a canonical unavailability result after validating the input.
 * A usable result (once the engine is ported) is persisted into the injected index.
 * @param deps - optional chemistry-index upsert.
 * @returns a registry-ready tool definition.
 */
export function createRecognizeChemicalStructureTool(deps: RecognizeChemicalStructureDeps = {}): ToolDefinition {
  return defineTool({
    name: 'recognize_chemical_structure',
    description: DESCRIPTION,
    parameters: {
      image_path: { type: 'string', description: '化学结构图图片路径（工作区相对或绝对路径，支持 jpg/png/gif/webp；PDF 页请先导出为图片）' },
      text: { type: 'string', description: '文档文本片段（说明书/权利要求）或单独的化合物名称（name→SMILES）' },
      mode: { type: 'string', enum: ['image', 'text', 'auto'], description: '识别模式：image 走图片两步法；text 走文本三级流水线；auto 按输入分派（默认）' },
      claim_context: { type: 'string', description: '权利要求或技术方案文本（图文对齐，可提高识别准确率）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imagePath: { type: 'string' },
          sourceText: { type: 'string' },
          kind: { type: 'string', required: true, enum: CHEMICAL_KINDS },
          candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
          chosenIndex: { type: 'integer', required: true },
          canonicalSmiles: { type: 'string' },
          formula: { type: 'string' },
          names: { type: 'array', required: true, items: { type: 'string' } },
          confidence: { type: 'number', required: true },
          warnings: WARNINGS_SCHEMA,
          needHumanReview: { type: 'boolean', required: true },
          usable: { type: 'boolean', required: true },
          modelUsed: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderChemicalStructure(value) }],
    },
    async execute(args) {
      const mode: RecognizeChemicalStructureMode = args.mode ?? (args.image_path ? 'image' : 'text')
      if (mode === 'image' && !args.image_path) {
        throw new PatentToolError('invalid_tool_input', 'image 模式必须提供 image_path。', { tool: 'recognize_chemical_structure' })
      }
      if (mode === 'text' && !args.text?.trim()) {
        throw new PatentToolError('invalid_tool_input', 'text 模式必须提供非空 text。', { tool: 'recognize_chemical_structure' })
      }

      // RDKit 未安装（可选原生依赖）：识别引擎整体不可用。返回 canonical
      // 不可用结果（软结果 + 标记字段），而非抛 setup_required，使模型能
      // 读到"本能力未就绪"并改用人工确认。
      const result: ChemicalStructureResult = {
        ...(args.image_path === undefined ? {} : { imagePath: args.image_path }),
        ...(args.text === undefined ? {} : { sourceText: args.text }),
        kind: 'structure',
        candidates: [],
        chosenIndex: -1,
        names: [],
        confidence: 0,
        warnings: [UNAVAILABLE_WARNING],
        needHumanReview: true,
        usable: false,
        modelUsed: 'unavailable',
      }
      // 当前构建识别引擎不可用，usable 恒 false，写入分支不可达（RDKit 接入后移除 ignore）。
      /* v8 ignore next 11 -- only reachable once the chemistry engine is wired and produces a usable result. */
      if (result.usable && deps.upsertIndex !== undefined) {
        try {
          await deps.upsertIndex({
            sourceKey: resolveChemicalSourceKey(args),
            analyzedAt: new Date().toISOString(),
            analysis: result,
          })
        } catch {
          // 索引写入是可选增强：写入失败静默降级，不阻断识别结果返回。
        }
      }
      return result
    },
  })
}
