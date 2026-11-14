/**
 * `law_verify` tool: decide law citations against the shipped index.
 *
 * The tool reports what it can and cannot support. An article that is indexed but
 * not yet transcribed is reported as unverified rather than accepted, so a
 * partially transcribed index never reads as a clean bill of health.
 * @module @deepseek-ai/dsh-patent-law/tool/law-verify
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
  countCitationDecisions,
} from '@deepseek-ai/dsh-patent-core'
import { formatLawReference, parseLawReference, scanUnrecognizedCitations } from '../reference.ts'
import { renderCitationRows, resolveCitationPolicy, verifyCitation, verifyCitations } from '../verify.ts'
import type { VerifyOptions } from '../verify.ts'
import type {
  CitationDecision,
  CitationFinding,
  CitationPolicy,
  CitationPolicySet,
  LawBaseline,
  LawName,
  StatuteName,
} from '../types.ts'

/** Thrown when the tool input cannot be turned into references to check. */
export class LawVerifyToolError extends Error {
  /** Stable error code for callers that catch this error. */
  readonly code: string

  /**
   * @param code - stable error code.
   * @param message - what is wrong with the input.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LawVerifyToolError'
    this.code = code
  }
}

/** Input for the law_verify tool. */
export type LawVerifyInput = {
  /** Free text whose citations are extracted and checked. */
  text?: string
  /** References to check as written, each of which must parse as exactly one reference. */
  references?: string[]
  /** The proposition the citations are offered in support of, when there is one. */
  proposition?: string
}

/** One checked citation as the tool reports it. */
export type LawVerifyFinding = {
  /** The reference as written. */
  raw: string
  /** The law it belongs to, when the reference could be read. */
  law?: string
  /** Article number, for a statute reference. */
  article?: number
  /** Paragraph number, when the reference names one. */
  paragraph?: number
  /** Item number, when the reference names one; reported, not checked. */
  item?: number
  /** Normalized guideline section path, for a guideline reference. */
  sectionPath?: string
  decision: CitationDecision
  /** How this deployment treats the decision. */
  policy: CitationPolicy
  reason: string
}

/** Output of the law_verify tool. */
export type LawVerifyOutput = {
  findings: LawVerifyFinding[]
  /** True when at least one finding is treated as a block. */
  blocked: boolean
  counts: Record<CitationDecision, number>
  /**
   * Citation-like fragments in the input text that the parser did not resolve.
   * They were not checked, so a table with findings is not a complete check
   * when this list is non-empty.
   */
  unrecognized: string[]
}

/** Injected collaborators: the loaded index and the deployment's policy. */
export type LawVerifyToolOptions = {
  baselines: Map<LawName, LawBaseline>
  policies: CitationPolicySet
  /** Overlap a proposition must reach before an entry's text supports it; defaults to {@link PROPOSITION_SUPPORT_DEFAULT}. */
  supportThreshold?: number
}

const DESCRIPTION = [
  '- Checks law citations against the law index shipped with this deployment: 《专利法》《专利法实施细则》, seven patent judicial interpretations, and eight departmental regulations by article (and paragraph); 《专利审查指南》 by normalized section path.',
  '- Each citation is decided as 已核验 / 与所引命题不符 / 未与条文对应（未判定）/ 条号超出有效范围 / 索引中不存在 / 条文未转录（未核验）. A decision is never reported as checked when it was not: an indexed article whose text has not been transcribed comes back as 未核验, and an article beyond an article ceiling that has itself not been verified also comes back as 未核验.',
  '- Pass the text whose citations you want checked (citations are extracted from it), or pass exact references. A reference that is not exactly one reference is a tool error, so a typo surfaces instead of being skipped. Blank text without references is an input error, so a zero-byte call cannot stand in for a completed check.',
  '- A citation-like fragment in the text that the parser cannot resolve is returned in `unrecognized` and was not checked. A result with findings is not a complete check while that list is non-empty: rewrite the fragment as a full reference or verify it separately.',
  '- Pass proposition when a citation is offered in support of a specific claim. The cited entry must carry that claim, by naming its subject in the entry\'s own topic keywords or by sharing the entry\'s transcribed wording; 与所引命题不符 means another entry of the same law carries the claim instead (the reason names it), and 未与条文对应（未判定） means no entry does, so nothing here decides the claim and a person must.',
  '- This checks citation form and index membership, not legal correctness of the actual text: the index carries transcribed text only after a person records the transcription source. An article that is 未核验 still has to be verified against an official source (patent_case_search / cnlaw / web_fetch on the official page) before it is relied on.',
  '',
  'Usage notes:',
  '  - Read-only, offline, and makes no network request.',
  '  - A result with no findings means no citation was recognized, not that the text is correct.',
].join('\n')

/**
 * Create the `law_verify` tool over a loaded index.
 * @param options - the loaded index and the citation policy.
 * @returns the tool definition.
 */
export function createLawVerifyTool(options: LawVerifyToolOptions): ToolDefinition {
  const { baselines, policies, supportThreshold } = options
  return defineTool(citationVerifyToolOptions({
    name: 'law_verify',
    description: DESCRIPTION,
    referenceExample: '专利法第22条第3款 / 审查指南第二部分第四章3.2.1.1',
    findingSchema: FINDING_SCHEMA,
    report: renderToolReport,
    run: args => runVerify(args, baselines, policies, supportThreshold),
  }))
}

const FINDING_SCHEMA = citationFindingSchema({
  raw: { type: 'string', required: true },
  law: { type: 'string' },
  article: { type: 'number' },
  paragraph: { type: 'number' },
  item: { type: 'number' },
  sectionPath: { type: 'string' },
  ...CITATION_FINDING_DECISION_PROPERTIES,
})

/** Run the verification and project it into the tool's output value. */
function runVerify(
  args: LawVerifyInput,
  baselines: Map<LawName, LawBaseline>,
  policies: CitationPolicySet,
  supportThreshold: number | undefined,
): LawVerifyOutput {
  const problem = citationInputProblem(args)
  if (problem !== null) throw new LawVerifyToolError(problem.code, problem.message)
  const findings = collectFindings(args, baselines, supportThreshold)
  return citationVerifyReport({
    findings,
    project: finding => toFinding(finding, policies),
    count: countDecisions,
    unrecognized: () => args.text === undefined
      ? []
      : scanUnrecognizedCitations(args.text, findings.map(finding => finding.reference)),
  })
}

/** Collect the findings for the requested text and references. */
function collectFindings(
  args: LawVerifyInput,
  baselines: Map<LawName, LawBaseline>,
  supportThreshold: number | undefined,
): CitationFinding[] {
  const options: VerifyOptions = {
    ...(args.proposition === undefined ? {} : { proposition: args.proposition }),
    ...(supportThreshold === undefined ? {} : { supportThreshold }),
  }
  const references = args.references ?? []
  const findings = args.text === undefined ? [] : verifyCitations(args.text, baselines, options)
  for (const raw of references) {
    const reference = parseLawReference(raw)
    if (reference === null) {
      throw new LawVerifyToolError('unparsable_reference', `无法把「${raw}」解析为单条法条引用：请给出条号（如 专利法第22条第3款）或指南节（如 审查指南第二部分第四章3.2.1.1）`)
    }
    findings.push(verifyCitation(reference, baselines, options))
  }
  return findings
}

/** Project one finding into the tool's serializable form. */
function toFinding(finding: CitationFinding, policies: CitationPolicySet): LawVerifyFinding {
  const reference = finding.reference
  return {
    raw: finding.raw,
    law: reference.law,
    ...(reference.kind === 'law-article' ? { article: reference.article } : {}),
    ...(reference.kind === 'law-article' && reference.paragraph !== undefined
      ? { paragraph: reference.paragraph }
      : {}),
    ...(reference.kind === 'law-article' && reference.item !== undefined
      ? { item: reference.item }
      : {}),
    ...(reference.kind === 'guideline-section' ? { sectionPath: reference.path } : {}),
    decision: finding.decision,
    policy: resolveCitationPolicy(finding, policies),
    reason: finding.reason,
  }
}

/** Count the findings by decision. */
function countDecisions(findings: LawVerifyFinding[]): Record<CitationDecision, number> {
  return countCitationDecisions(findings)
}

/** Render one finding as the canonical reference the table shows. */
function findingLabel(finding: LawVerifyFinding): string {
  if (finding.sectionPath !== undefined) {
    return formatLawReference({
      kind: 'guideline-section',
      law: '专利审查指南',
      path: finding.sectionPath,
      raw: finding.raw,
    })
  }
  return formatLawReference({
    kind: 'law-article',
    law: finding.law as StatuteName,
    article: finding.article as number,
    ...(finding.paragraph === undefined ? {} : { paragraph: finding.paragraph }),
    ...(finding.item === undefined ? {} : { item: finding.item }),
    raw: finding.raw,
  })
}

/** Render the tool report: the decision table plus what a block or a gap means. */
function renderToolReport(findings: LawVerifyFinding[], blocked: boolean, unrecognized: string[]): string {
  const lines = citationReportLines(findings, unrecognized, findingLabel, renderCitationRows)
  if (blocked) {
    lines.push('', '**存在被拦截的引用**：先补证或改写该断言，再交付。')
  }
  if (findings.some(finding => finding.decision === 'unverified')) {
    lines.push('', '存在未核验引用：本索引没有可用于判定该引用的文本（该条目及其子节都未转录），因此既不能放行也不能比对；该引用必须另找官方来源核验。')
  }
  if (findings.some(finding => finding.decision === 'unmatched')) {
    lines.push('', '存在未判定引用：所引条目的文本与该命题的字面重合不足，且本索引中没有条目支撑它。字面比对既不证明支撑也不证明不符——请人工核对该条是否承托该命题。')
  }
  return lines.join('\n')
}
