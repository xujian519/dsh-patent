/**
 * `patent_fees` tool: price a case's official fees against the shipped index.
 *
 * The tool reports the fee items the case owes, how many units of each, and the
 * statutory basis; money appears only where the index has a transcribed amount.
 * With the shipped index no amount is transcribed, so the report is the item
 * checklist plus a stated refusal to give a total — never a number the index
 * cannot support.
 * @module @deepseek-ai/dsh-patent-fees/tool/patent-fees
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { computeFees } from '../compute.ts'
import type { FeePolicy } from '../compute.ts'
import type {
  AmountStatus,
  FeeLine,
  FeeQuery,
  FeeTable,
  PatentType,
  ReductionKind,
  ReductionOutcome,
} from '../types.ts'

/** Thrown when the tool input cannot be priced. */
export class PatentFeesToolError extends Error {
  /** Stable error code for the model and logs. */
  readonly code: string

  /**
   * @param code - stable error code.
   * @param message - what is wrong with the input.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PatentFeesToolError'
    this.code = code
  }
}

/**
 * Input for the patent_fees tool. Its parameters are the case facts a fee query
 * carries, so the tool's validated arguments and the query are one type.
 */
export type PatentFeesInput = FeeQuery

/** One priced fee item as the tool reports it. Nullable fields are omitted while unrecorded. */
export type FeeLineValue = {
  id: string
  name: string
  /** How the quantity is counted. */
  basis: string
  quantity: number
  quantityBasis: string
  unitAmount?: string
  subtotal?: string
  payable?: string
  status: AmountStatus
  reduction?: string
  legalBasis?: string
  sourceDoc?: string
  verifiedOn?: string
  notes: string[]
}

/** A fee item the query could not price. */
export type PendingFeeValue = {
  id: string
  name: string
  requiredInput: string
  reason: string
}

/** What the reduction request resolved to, with an unrecorded ratio left out. */
type ReductionValue = {
  kind: ReductionKind
  filed: boolean
  reductionPercent?: string
  applied: boolean
  reason: string
}

/** Output of the patent_fees tool. */
export type PatentFeesOutput = {
  patentType: PatentType
  currency: string
  lines: FeeLineValue[]
  pending: PendingFeeValue[]
  total: { amount?: string; complete: boolean; unverifiedIds: string[]; uncoveredTriggers?: string[] }
  reduction?: ReductionValue
  notes: string[]
}

/** Injected collaborators: the loaded index and the deployment's policy. */
export type PatentFeesToolOptions = {
  table: FeeTable
  policy: FeePolicy
}

const DESCRIPTION = [
  '- Prices the official fees of one Chinese patent case against the fee index shipped with this deployment: the items the case owes, how many units of each, whether a fee reduction applies, the annual-fee tier of each year, and the surcharge on a late annual fee.',
  '- Report the case facts the index counts with (claims / specificationPages / priorityClaims / extensionMonths / annuityYears / lateMonths). A fact the priced items need but the call omits comes back under pending, naming the input, rather than being guessed.',
  '- Announce every step of the case in triggers. A step you do not name is not priced at all, so a grant or a procedure left out reads as "no fee" — this list is the report\'s coverage, not a hint.',
  '- Money is reported only from transcribed amounts. Each line carries status: verified (amount and its verification date are recorded), unverified (amount recorded, verification date is not), or unrecorded (no amount yet). With the shipped index 17 of 19 items carry transcribed, verified amounts; specification-surcharge and extension-fee stay unrecorded because their tiered pricing does not fit one unit amount, so those two lines carry no figures and withhold the total.',
  '- The total is withheld while any applicable line is not verified, and the ids that withhold it are listed. A trigger the index carries no item for is reported under total.uncoveredTriggers and also withholds the total. Never fill in a missing amount or an unindexed stage yourself, and never quote a total this tool refused: an amount that is not transcribed is unknown, not free.',
  '- annuityYears is the list of patent years to price; it comes from patent_deadlines, which owns the dates. lateMonths is the number of started months of delay, likewise from that tool.',
  '- This is arithmetic over an index, not a fee quote: the index carries a fee item\'s structure and transcribed amount with its verification date. Confirm any amount against the official announcement before invoicing a client.',
  '',
  'Usage notes:',
  '  - Read-only, offline, and makes no network request.',
  '  - An empty lines array means no indexed item matched the named triggers and patent type.',
].join('\n')

/**
 * Create the `patent_fees` tool over a loaded fee index.
 * @param options - the loaded index and the total policy.
 * @returns the tool definition.
 */
export function createPatentFeesTool(options: PatentFeesToolOptions): ToolDefinition {
  const { table, policy } = options
  return defineTool({
    name: 'patent_fees',
    description: DESCRIPTION,
    parameters: {
      patentType: {
        type: 'string',
        required: true,
        enum: ['invention', 'utility-model', 'design'],
        description: 'Patent type of the case',
      },
      triggers: {
        type: 'array',
        required: true,
        items: {
          type: 'string',
          enum: [
            'filing',
            'substantive-examination',
            'grant-registration',
            'annual-fee',
            'reexamination',
            'invalidation',
            'evaluation-report',
            'restoration',
            'extension',
            'record-change',
            'pct-grace',
          ],
        },
        description: 'Steps of this case, e.g. ["filing","substantive-examination"]',
      },
      claims: { type: 'number', description: 'Total claim count, for the claim-count surcharge' },
      specificationPages: { type: 'number', description: 'Specification page count, for the page-count surcharge' },
      priorityClaims: { type: 'number', description: 'Number of priority claims made' },
      annuityYears: {
        type: 'array',
        items: { type: 'number' },
        description: 'Patent years to price, 1-based, taken from patent_deadlines',
      },
      extensionMonths: { type: 'number', description: 'Months of extension requested' },
      lateMonths: { type: 'number', description: 'Started months of delay on the annual fee' },
      reduction: REDUCTION_SCHEMA,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patentType: { type: 'string', required: true, enum: ['invention', 'utility-model', 'design'] },
          currency: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: LINE_SCHEMA },
          pending: { type: 'array', required: true, items: PENDING_SCHEMA },
          total: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              amount: { type: 'string' },
              complete: { type: 'boolean', required: true },
              unverifiedIds: { type: 'array', required: true, items: { type: 'string' } },
              uncoveredTriggers: { type: 'array', items: { type: 'string' } },
            },
          },
          reduction: {
            ...REDUCTION_SCHEMA,
            properties: {
              ...REDUCTION_SCHEMA.properties,
              reductionPercent: { type: 'string' },
              applied: { type: 'boolean', required: true },
              reason: { type: 'string', required: true },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderFeeReport(value) }],
    },
    execute(args) {
      const report = computeFees(table, toQuery(args), { policy })
      return Promise.resolve({
        patentType: args.patentType,
        currency: report.currency,
        lines: report.lines.map(toLineValue),
        pending: report.pending,
        total: {
          ...(report.total.amount === null ? {} : { amount: report.total.amount }),
          complete: report.total.complete,
          unverifiedIds: report.total.unverifiedIds,
          ...report.total.uncoveredTriggers === undefined
            ? {}
            : { uncoveredTriggers: report.total.uncoveredTriggers },
        },
        ...(report.reduction === null ? {} : { reduction: toReductionValue(report.reduction) }),
        notes: report.notes,
      })
    },
  })
}

/** The id and name every reported fee value carries. */
const NAMED_VALUE_PROPERTIES = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
} as const

/** The reduction the case asks for, as a tool parameter and in the output. */
const REDUCTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'The fee reduction the case qualifies for',
  properties: {
    kind: { type: 'string', required: true, enum: ['individual', 'enterprise'] },
    filed: { type: 'boolean', required: true, description: 'Whether the reduction record was filed' },
  },
} as const

const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...NAMED_VALUE_PROPERTIES,
    basis: { type: 'string', required: true },
    quantity: { type: 'number', required: true },
    quantityBasis: { type: 'string', required: true },
    unitAmount: { type: 'string' },
    subtotal: { type: 'string' },
    payable: { type: 'string' },
    status: { type: 'string', required: true, enum: ['verified', 'unverified', 'unrecorded'] },
    reduction: { type: 'string' },
    legalBasis: { type: 'string' },
    sourceDoc: { type: 'string' },
    verifiedOn: { type: 'string' },
    notes: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const PENDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...NAMED_VALUE_PROPERTIES,
    requiredInput: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

/** Turn the validated arguments into a fee query, rejecting what cannot be priced. */
function toQuery(args: PatentFeesInput): FeeQuery {
  if (args.triggers.length === 0) {
    throw new PatentFeesToolError(
      'no_triggers',
      'triggers 不能为空：未指定环节时本工具不会报告任何费用，那不等于本案无费用。请列出本案涉及的环节，如 ["filing"]。',
    )
  }
  return {
    patentType: args.patentType,
    triggers: args.triggers,
    ...(args.claims === undefined ? {} : { claims: count(args.claims, 'claims') }),
    ...(args.specificationPages === undefined
      ? {}
      : { specificationPages: count(args.specificationPages, 'specificationPages') }),
    ...(args.priorityClaims === undefined ? {} : { priorityClaims: count(args.priorityClaims, 'priorityClaims') }),
    ...(args.extensionMonths === undefined ? {} : { extensionMonths: count(args.extensionMonths, 'extensionMonths') }),
    ...(args.lateMonths === undefined ? {} : { lateMonths: count(args.lateMonths, 'lateMonths') }),
    ...(args.annuityYears === undefined ? {} : { annuityYears: annuityYears(args.annuityYears) }),
    ...(args.reduction === undefined ? {} : { reduction: args.reduction }),
  }
}

/** Check a count argument, which must be a non-negative integer. */
function count(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new PatentFeesToolError('invalid_count', `${label} 必须是非负整数，得到：${String(value)}`)
  }
  return value
}

/** Validate the annual-fee year list. */
function annuityYears(years: readonly number[]): number[] {
  for (const year of years) {
    if (!Number.isInteger(year) || year < 1) {
      throw new PatentFeesToolError('invalid_annuity_year', `annuityYears 只能是正整数专利年度，得到：${String(year)}`)
    }
  }
  return [...years]
}

/** Project one priced line: fields that are not recorded are left out. */
function toLineValue(line: FeeLine): FeeLineValue {
  return {
    id: line.id,
    name: line.name,
    basis: line.basis,
    quantity: line.quantity,
    quantityBasis: line.quantityBasis,
    ...(line.unitAmount === null ? {} : { unitAmount: line.unitAmount }),
    ...(line.subtotal === null ? {} : { subtotal: line.subtotal }),
    ...(line.payable === null ? {} : { payable: line.payable }),
    status: line.status,
    ...(line.reduction === null ? {} : { reduction: line.reduction }),
    ...(line.legalBasis === null ? {} : { legalBasis: line.legalBasis }),
    ...(line.valueSource.sourceDoc === null ? {} : { sourceDoc: line.valueSource.sourceDoc }),
    ...(line.valueSource.verifiedOn === null ? {} : { verifiedOn: line.valueSource.verifiedOn }),
    notes: line.notes,
  }
}

/** Project the resolved reduction, leaving out a ratio that is not recorded. */
function toReductionValue(reduction: ReductionOutcome): ReductionValue {
  return {
    kind: reduction.kind,
    filed: reduction.filed,
    ...(reduction.reductionPercent === null ? {} : { reductionPercent: reduction.reductionPercent }),
    applied: reduction.applied,
    reason: reduction.reason,
  }
}

const STATUS_LABELS: Record<AmountStatus, string> = {
  verified: '已核验',
  unverified: '未核验',
  unrecorded: '金额未转录',
}

/** Render the report: the priced items, what still has to be supplied, and the total. */
function renderFeeReport(report: PatentFeesOutput): string {
  const lines: string[] = [renderFeeTable(report)]
  lines.push('', renderTotal(report))
  if (report.reduction !== undefined) {
    lines.push('', `**费用减缴**：${report.reduction.reason}`)
  }
  if (report.pending.length > 0) {
    lines.push('', '**待补输入**（本工具不自行推算）：')
    for (const item of report.pending) {
      lines.push(`- ${item.name}（${item.id}）：需要 ${item.requiredInput}——${item.reason}`)
    }
  }
  const notes = [...report.notes, ...report.lines.flatMap(line => line.notes.map(note => `${line.name}：${note}`))]
  if (notes.length > 0) {
    lines.push('', '**说明**：')
    for (const note of notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}

/** The priced items as a Markdown table. */
function renderFeeTable(report: PatentFeesOutput): string {
  if (report.lines.length === 0) {
    return '本次没有可计价的费用条目：所给 triggers 与专利类型在索引中没有匹配项。这不等于本案没有费用——请核对 triggers 是否漏了环节。'
  }
  const rows = report.lines.map((line) => {
    const money = line.unitAmount === undefined ? '—' : line.unitAmount
    const subtotal = line.subtotal === undefined ? '—' : line.subtotal
    const payable = line.payable === undefined ? '—' : line.payable
    return `| ${line.name} | ${line.quantityBasis} | ${String(line.quantity)} | ${money} | ${subtotal} | ${payable} | ${STATUS_LABELS[line.status]} | ${line.legalBasis ?? '—'} |`
  })
  return [
    `| 费用项 | 计数依据 | 数量 | 单价(${report.currency}) | 小计 | 应付 | 金额状态 | 依据 |`,
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/** The total line, stating the refusal when it applies. */
function renderTotal(report: PatentFeesOutput): string {
  const uncovered = report.total.uncoveredTriggers ?? []
  if (uncovered.length > 0) {
    return `**本次未给出合计**：索引未收录收费阶段 ${uncovered.join('、')}。未收录的阶段是未知，不是零；须先补录该阶段的费项再核价。`
  }
  if (report.total.complete && report.total.amount !== undefined) {
    return `**合计（全部已核验）**：${report.total.amount} ${report.currency}`
  }
  const withheld = report.total.unverifiedIds.join('、')
  return report.total.amount === undefined
    ? `**本次未给出合计**：${String(report.total.unverifiedIds.length)} 项适用费用没有已核验金额（${withheld}）。索引未转录的金额是未知，不是零；须按官方收费标准公告补录或另行核价。`
    : `**部分合计**：${report.total.amount} ${report.currency}（仅含已核验项；${withheld} 未计入）`
}
