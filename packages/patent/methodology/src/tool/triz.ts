/**
 * The model-facing triz tool: list the 40 inventive principles and the 39
 * engineering parameters, or look up one contradiction-matrix cell given an
 * improving/worsening parameter pair.
 * @module @deepseek-ai/dsh-methodology/tool/triz
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ENGINEERING_PARAMS, loadPrinciples, loadSeparations, lookupMatrixCell, paramLabel, principleById } from '../data.ts'
import type { TrizPrinciple, TrizSeparation } from '../types.ts'

/** Tool input: an optional improving/worsening parameter pair (both or neither). */
export type TrizInput = {
  /** Improving engineering parameter number, 1-39. */
  improving?: number
  /** Worsening engineering parameter number, 1-39. */
  worsening?: number
}

/** One engineering parameter as returned to the model. */
export type TrizParameterView = {
  number: number
  label: string
}

/** One inventive principle as returned to the model. */
export type TrizPrincipleView = {
  number: number
  name: string
  description: string
}

/** One separation principle as returned to the model. */
export type TrizSeparationView = {
  name: string
  description: string
  signals: string[]
}

/** The tool's canonical result, inferred from the output schema. */
export type TrizOutput = InferValue<typeof OUTPUT_SCHEMA>

/** The catalog branch of {@link TrizOutput}. */
type CatalogOutput = Extract<TrizOutput, { mode: 'catalog' }>

/** The matrix-cell branch of {@link TrizOutput}. */
type LookupOutput = Extract<TrizOutput, { mode: 'lookup' }>

const PARAMETER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer', required: true },
    label: { type: 'string', required: true },
  },
} as const

const PRINCIPLE_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
  },
} as const

const SEPARATION_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    signals: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const CATALOG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', const: 'catalog', required: true },
    parameters: { type: 'array', required: true, items: PARAMETER_VIEW_SCHEMA },
    principles: { type: 'array', required: true, items: PRINCIPLE_VIEW_SCHEMA },
  },
} as const

const LOOKUP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', const: 'lookup', required: true },
    improving: { ...PARAMETER_VIEW_SCHEMA, required: true },
    worsening: { ...PARAMETER_VIEW_SCHEMA, required: true },
    recommended: { type: 'array', required: true, items: PRINCIPLE_VIEW_SCHEMA },
    separations: { type: 'array', required: true, items: SEPARATION_VIEW_SCHEMA },
  },
} as const

const OUTPUT_SCHEMA = {
  oneOf: [CATALOG_OUTPUT_SCHEMA, LOOKUP_OUTPUT_SCHEMA],
} as const

const DESCRIPTION = [
  '- TRIZ inventive problem solving: the 40 inventive principles and the 39x39 Altshuller contradiction matrix',
  '- Call with no arguments to list all 39 engineering parameters and 40 principles',
  '- Call with an improving and a worsening parameter number (1-39) to read that matrix cell and its recommended principles',
  '- Use for technical contradictions, trade-offs, and patent design-around',
  '- This tool only reads the matrix for explicit parameter numbers; extracting parameters or contradictions from a document is outside its scope',
].join('\n')

function parameterView(no: number): TrizParameterView {
  return { number: no, label: paramLabel(no) }
}

function principleView(principle: TrizPrinciple): TrizPrincipleView {
  return { number: principle.no, name: principle.name, description: principle.description }
}

function separationView(separation: TrizSeparation): TrizSeparationView {
  return {
    name: separation.name,
    description: separation.description,
    signals: separation.signals,
  }
}

function allSeparations(): TrizSeparationView[] {
  return loadSeparations().map(separationView)
}

function allParameters(): TrizParameterView[] {
  return ENGINEERING_PARAMS.map(param => parameterView(param.no))
}

function allPrinciples(): TrizPrincipleView[] {
  return loadPrinciples().map(principleView)
}

/** Render the full catalog as Markdown. */
function renderCatalog(value: CatalogOutput): string {
  const lines = [
    'TRIZ: 39 engineering parameters and 40 inventive principles.',
    '',
    '## Engineering parameters',
    ...value.parameters.map(param => `- ${param.number}. ${param.label}`),
    '',
    '## Inventive principles',
    ...value.principles.map(principle => `- ${principle.number}. ${principle.name} — ${principle.description}`),
  ]
  return lines.join('\n')
}

/** Render one matrix-cell lookup as Markdown. */
function renderLookup(value: LookupOutput): string {
  const header = `Contradiction matrix: improving ${value.improving.label} (${value.improving.number}) → worsening ${value.worsening.label} (${value.worsening.number})`
  if (value.recommended.length === 0) {
    // 空单元有两种：对角线（同一参数即物理矛盾）与转写本身就留空的非对角线格。
    // 只有前者是物理矛盾；把 234 个非对角线空格也说成物理矛盾会把结论引向错误方向。
    if (value.improving.number === value.worsening.number) {
      return [
        header,
        '',
        'Recommended principles: none. This is a diagonal cell: improving equals worsening, a physical contradiction that classical TRIZ resolves by separation rather than a matrix entry.',
        '',
        'Separation principles:',
        ...value.separations.map(separation => `- ${separation.name} — ${separation.description} Signals: ${separation.signals.join('; ')}`),
      ].join('\n')
    }
    const empty = 'This transcription records no recommendation for this pair: a gap in this matrix edition, not a claim that classical TRIZ has none. This is not a diagonal cell, so a separation move does not apply; check whether the pair names the parameters actually in conflict.'
    return `${header}\n\nRecommended principles: none. ${empty}`
  }
  const lines = [
    header,
    '',
    'Recommended principles: ' + value.recommended.map(principle => principle.number).join(', '),
    '',
    ...value.recommended.map(principle => `- ${principle.number}. ${principle.name} — ${principle.description}`),
  ]
  return lines.join('\n')
}

/** Render the canonical value into model-facing Markdown. */
function renderTriz(value: TrizOutput): string {
  switch (value.mode) {
    case 'catalog':
      return renderCatalog(value)
    case 'lookup':
      return renderLookup(value)
    default:
      return exhaustiveMode(value)
  }
}

/** 穷尽性收尾：封闭联合的默认分支不可达（未来新增 mode 时此处编译失败）。 */
function exhaustiveMode(value: never): never {
  throw new Error(`未知 TrizOutput mode: ${String((value as { mode: unknown }).mode)}`)
}

/**
 * Build the triz tool over the shipped TRIZ data assets.
 * @returns a registry-ready tool definition.
 */
export function createTrizTool(): ToolDefinition {
  return defineTool({
    name: 'triz',
    description: DESCRIPTION,
    parameters: {
      improving: {
        type: 'integer',
        description: 'Improving engineering parameter number (1-39). Omit it together with worsening to list the full catalog.',
      },
      worsening: {
        type: 'integer',
        description: 'Worsening engineering parameter number (1-39). Provide it only together with improving.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderTriz(value) }],
    },
    // The tool reads immutable shipped data; sibling calls cannot interfere.
    isConcurrencySafe: () => true,
    execute(args) {
      if (args.improving === undefined && args.worsening === undefined) {
        return Promise.resolve({ mode: 'catalog', parameters: allParameters(), principles: allPrinciples() } as const)
      }
      if (args.improving === undefined || args.worsening === undefined) {
        throw new Error('triz requires both improving and worsening, or neither (for the full catalog)')
      }
      const improving = args.improving
      const worsening = args.worsening
      if (!Number.isInteger(improving) || improving < 1 || improving > 39) {
        throw new Error('triz improving must be an integer 1-39')
      }
      if (!Number.isInteger(worsening) || worsening < 1 || worsening > 39) {
        throw new Error('triz worsening must be an integer 1-39')
      }
      const ids = lookupMatrixCell(improving, worsening)
      return Promise.resolve({
        mode: 'lookup',
        improving: parameterView(improving),
        worsening: parameterView(worsening),
        recommended: ids.flatMap((id) => {
          const principle = principleById(id)
          return principle === undefined ? [] : [principleView(principle)]
        }),
        separations: improving === worsening ? allSeparations() : [],
      } as const)
    },
  })
}
