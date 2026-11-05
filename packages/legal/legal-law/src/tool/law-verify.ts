/**
 * `legal_law_verify` tool: decide law citations against the shipped legal-law index.
 *
 * The tool reports what it can and cannot support. An article that is indexed but
 * not yet transcribed is reported as unverified rather than accepted.
 * @module @deepseek-ai/dsh-legal-law/tool/law-verify
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  CITATION_FINDING_DECISION_PROPERTIES,
  citationFindingSchema,
  citationInputProblem,
  citationReportLines,
  citationVerifyReport,
  citationVerifyToolOptions,
} from '@deepseek-ai/dsh-law-core'
import { extractLegalLawReferences, formatLegalLawReference, parseLegalLawReference, scanUnrecognizedLegalCitations } from '../reference.ts'
import { renderLegalCitationRows, resolveLegalCitationPolicy, verifyLegalCitation } from '../verify.ts'
import type { LegalVerifyOptions } from '../verify.ts'
import type {
  LegalCitationDecision,
  LegalCitationFinding,
  LegalCitationPolicy,
  LegalCitationPolicySet,
  LegalLawBaseline,
  LegalLawIndex,
  LegalLawName,
  LegalLawReference,
} from '../types.ts'

/** Thrown when the tool input cannot be turned into references to check. */
export class LegalLawVerifyToolError extends Error {
  /** Stable error code for callers that catch this error. */
  readonly code: string

  /**
   * @param code - stable error code.
   * @param message - what is wrong with the input.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LegalLawVerifyToolError'
    this.code = code
  }
}

/** Input for the legal_law_verify tool. */
export type LegalLawVerifyInput = {
  /** Free text whose citations are extracted and checked. */
  text?: string
  /** References to check as written, each of which must parse as exactly one reference. */
  references?: string[]
  /** The proposition the citations are offered in support of, when there is one. */
  proposition?: string
}

/** One checked citation as the tool reports it. */
export type LegalLawVerifyFinding = {
  /** The reference as written. */
  raw: string
  /** The law it belongs to. */
  law: string
  /** Article number. */
  article: number
  /** Paragraph number, when the reference names one. */
  paragraph?: number
  /** Item number, when the reference names one. */
  item?: number
  decision: LegalCitationDecision
  /** How this deployment treats the decision. */
  policy: LegalCitationPolicy
  reason: string
}

/** Output of the legal_law_verify tool. */
export type LegalLawVerifyOutput = {
  findings: LegalLawVerifyFinding[]
  /** True when at least one finding is treated as a block. */
  blocked: boolean
  counts: Record<LegalCitationDecision, number>
  /**
   * Citation-like fragments in the input text that the parser did not resolve.
   */
  unrecognized: string[]
}

/** Injected collaborators: the index and the deployment's policy. */
export type LegalLawVerifyToolOptions = {
  /**
   * A loaded index, or an index that parses a law only when a citation names
   * it. An index reads its manifest once; a rejection leaves the next call free
   * to retry.
   */
  baselines: Map<LegalLawName, LegalLawBaseline> | LegalLawIndex
  policies: LegalCitationPolicySet
  /** Overlap a proposition must reach before an entry's text supports it. */
  supportThreshold?: number
}

const DESCRIPTION = [
  '- Checks legal-law citations against the statutes the deployed index ships: any law name it declares (national laws, administrative regulations, local regulations, and judicial interpretations), by article and paragraph.',
  '- Each citation is decided as 已核验 / 与所引命题不符 / 未与条文对应（未判定）/ 条号超出有效范围 / 索引中不存在 / 条文未转录（未核验）. A decision is never reported as checked when it was not: an indexed article whose text has not been transcribed comes back as 未核验.',
  '- Pass the text whose citations you want checked (citations are extracted from it), or pass exact references. A reference that is not exactly one reference is a tool error.',
  '- A citation-like fragment in the text that the parser cannot resolve is returned in `unrecognized` and was not checked.',
  '- Pass proposition when a citation is offered in support of a specific claim.',
  '- This checks citation form and index membership, not legal correctness of the actual text.',
  '',
  'Usage notes:',
  '  - Read-only, offline, and makes no network request.',
  '  - A result with no findings means no citation was recognized, not that the text is correct.',
].join('\n')

/**
 * Create the `legal_law_verify` tool over an index.
 * @param options - the index and the citation policy.
 * @returns the tool definition.
 */
export function createLegalLawVerifyTool(options: LegalLawVerifyToolOptions): ToolDefinition {
  const { baselines: index, policies, supportThreshold } = options
  return defineTool(citationVerifyToolOptions({
    name: 'legal_law_verify',
    description: DESCRIPTION,
    referenceExample: '民法典第143条 / 劳动合同法第10条第2款',
    findingSchema: FINDING_SCHEMA,
    report: renderToolReport,
    run: async (args, signal) => {
      const problem = citationInputProblem(args)
      if (problem !== null) throw new LegalLawVerifyToolError(problem.code, problem.message)
      // The parser must know every law the index carries before it can read a
      // citation, so an on-demand index reads its manifest before extraction.
      // Only the laws the references name are parsed.
      if (!(index instanceof Map)) await index.loadNames(signal)
      signal.throwIfAborted()
      const references = referencesToCheck(args)
      const baselines = index instanceof Map
        ? index
        : await index.load(references.map(reference => reference.law), signal)
      return runVerify(args, references, baselines, policies, supportThreshold)
    },
  }))
}

const FINDING_SCHEMA = citationFindingSchema({
  raw: { type: 'string', required: true },
  law: { type: 'string', required: true },
  article: { type: 'number', required: true },
  paragraph: { type: 'number' },
  item: { type: 'number' },
  ...CITATION_FINDING_DECISION_PROPERTIES,
})

/**
 * Parse every reference the input asks about: the ones in `text`, then the
 * exact `references`.
 *
 * Reference parsing needs the index's law names but none of its article data,
 * so this runs after the manifest read and before any law file is parsed.
 * @param args - the tool input.
 * @returns the parsed references, in the order their findings are reported.
 * @throws LegalLawVerifyToolError when a requested reference is not exactly one reference.
 */
function referencesToCheck(args: LegalLawVerifyInput): LegalLawReference[] {
  const references = args.text === undefined ? [] : extractLegalLawReferences(args.text)
  for (const raw of args.references ?? []) {
    const reference = parseLegalLawReference(raw)
    if (reference === null) {
      throw new LegalLawVerifyToolError('unparsable_reference', `无法把「${raw}」解析为单条法条引用：请给出条号（如 民法典第143条）`)
    }
    references.push(reference)
  }
  return references
}

/** Run the verification and project it into the tool's output value. */
function runVerify(
  args: LegalLawVerifyInput,
  references: readonly LegalLawReference[],
  baselines: Map<LegalLawName, LegalLawBaseline>,
  policies: LegalCitationPolicySet,
  supportThreshold: number | undefined,
): LegalLawVerifyOutput {
  const options: LegalVerifyOptions = {
    ...(args.proposition === undefined ? {} : { proposition: args.proposition }),
    ...(supportThreshold === undefined ? {} : { supportThreshold }),
  }
  const findings = references.map(reference => verifyLegalCitation(reference, baselines, options))
  return citationVerifyReport({
    findings,
    project: finding => toFinding(finding, policies),
    count: countDecisions,
    unrecognized: () => args.text === undefined
      ? []
      : scanUnrecognizedLegalCitations(args.text, findings.map(finding => finding.reference)),
  })
}

/** Project one finding into the tool's serializable form. */
function toFinding(finding: LegalCitationFinding, policies: LegalCitationPolicySet): LegalLawVerifyFinding {
  const reference = finding.reference
  return {
    raw: finding.raw,
    law: reference.law,
    article: reference.article,
    ...(reference.paragraph === undefined ? {} : { paragraph: reference.paragraph }),
    ...(reference.item === undefined ? {} : { item: reference.item }),
    decision: finding.decision,
    policy: resolveLegalCitationPolicy(finding, policies),
    reason: finding.reason,
  }
}

/** Count the findings by decision. */
function countDecisions(findings: LegalLawVerifyFinding[]): Record<LegalCitationDecision, number> {
  const counts: Record<LegalCitationDecision, number> = {
    'valid': 0,
    'mismatch': 0,
    'unmatched': 0,
    'out-of-range': 0,
    'not-indexed': 0,
    'unverified': 0,
  }
  for (const finding of findings) counts[finding.decision] += 1
  return counts
}

/** Render one finding as the canonical reference the table shows. */
function findingLabel(finding: LegalLawVerifyFinding): string {
  return formatLegalLawReference({
    kind: 'law-article',
    law: finding.law,
    article: finding.article,
    ...(finding.paragraph === undefined ? {} : { paragraph: finding.paragraph }),
    ...(finding.item === undefined ? {} : { item: finding.item }),
    raw: finding.raw,
  })
}

/** Render the tool report: the decision table plus what a block or a gap means. */
function renderToolReport(findings: LegalLawVerifyFinding[], blocked: boolean, unrecognized: string[]): string {
  const lines = citationReportLines(findings, unrecognized, findingLabel, renderLegalCitationRows)
  if (blocked) {
    lines.push('', '**存在被拦截的引用**：先补证或改写该断言，再交付。')
  }
  if (findings.some(finding => finding.decision === 'unverified')) {
    lines.push('', '存在未核验引用：本索引没有可用于判定该引用的文本，因此既不能放行也不能比对；该引用必须另找官方来源核验。')
  }
  if (findings.some(finding => finding.decision === 'unmatched')) {
    lines.push('', '存在未判定引用：所引条目的文本与该命题的字面重合不足，且本索引中没有条目支撑它。字面比对既不证明支撑也不证明不符——请人工核对该条是否承托该命题。')
  }
  return lines.join('\n')
}
