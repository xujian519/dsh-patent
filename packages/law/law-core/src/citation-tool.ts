/**
 * 引用核验工具共用的声明式片段与报告行。
 *
 * 专利表与法律表的核验工具接受同样的三个输入、报告同样的六种判定，并在开头
 * 渲染同一张「引用 / 判定 / 处置 / 说明」表。这些片段不依赖工具框架，因此
 * 留在核心库里；两个域只提供各自的说明、finding 投影与解析器。
 * @module @deepseek-ai/dsh-law-core/citation-tool
 */

/** The input shape both citation-verify tools accept. */
export type CitationVerifyArgs = {
  /** Free text whose citations are extracted and checked. */
  text?: string
  /** References to check as written. */
  references?: string[]
}

/** What is wrong with a citation-verify tool input. */
export type CitationInputProblem = {
  /** Stable error code for callers that catch this error. */
  code: 'no_input'
  /** What the caller must add or fix. */
  message: string
}

/**
 * Check that the tool was given something to verify.
 * @param args - the tool input.
 * @returns the problem, or null when the input is usable.
 */
export function citationInputProblem(args: CitationVerifyArgs): CitationInputProblem | null {
  const references = args.references ?? []
  if (args.text === undefined && references.length === 0) {
    return { code: 'no_input', message: '至少要给出 text 或 references 之一' }
  }
  if (args.text !== undefined && args.text.trim().length === 0 && references.length === 0) {
    return { code: 'no_input', message: 'text 不能为空白：请给出要检查的文本，或用 references 列出引用' }
  }
  return null
}

/**
 * The parameters every citation-verify tool accepts.
 * @param referenceExample - example references for the domain, shown in the schema.
 * @returns the parameter schema.
 */
export function citationVerifyParameters(referenceExample: string): {
  readonly text: { readonly type: 'string'; readonly description: 'Text whose citations are extracted and checked' }
  readonly references: {
    readonly type: 'array'
    readonly items: { readonly type: 'string' }
    readonly description: `References to check as written, e.g. ${string}`
  }
  readonly proposition: { readonly type: 'string'; readonly description: 'What the citations are offered in support of' }
} {
  return {
    text: { type: 'string', description: 'Text whose citations are extracted and checked' },
    references: {
      type: 'array',
      items: { type: 'string' },
      description: `References to check as written, e.g. ${referenceExample}`,
    },
    proposition: { type: 'string', description: 'What the citations are offered in support of' },
  } as const
}

/** The decision, policy, and reason properties every finding schema carries. */
export const CITATION_FINDING_DECISION_PROPERTIES = {
  decision: {
    type: 'string',
    required: true,
    enum: ['valid', 'mismatch', 'unmatched', 'out-of-range', 'not-indexed', 'unverified'],
  },
  policy: { type: 'string', required: true, enum: ['block', 'warn', 'allow'] },
  reason: { type: 'string', required: true },
} as const

/** The blocked, counts, and unrecognized properties every output schema carries. */
export const CITATION_REPORT_PROPERTIES = {
  blocked: { type: 'boolean', required: true },
  counts: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: {
      'valid': { type: 'number', required: true },
      'mismatch': { type: 'number', required: true },
      'unmatched': { type: 'number', required: true },
      'out-of-range': { type: 'number', required: true },
      'not-indexed': { type: 'number', required: true },
      'unverified': { type: 'number', required: true },
    },
  },
  unrecognized: { type: 'array', required: true, items: { type: 'string' } },
} as const

/**
 * The finding schema every citation-verify tool declares.
 * @param properties - the domain's finding fields.
 * @returns the finding schema with the shared object rules applied.
 */
export function citationFindingSchema<const TProperties>(properties: TProperties): {
  readonly type: 'object'
  readonly additionalProperties: false
  readonly properties: TProperties
} {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
  } as const
}

/**
 * The output schema every citation-verify tool declares.
 * @param findingSchema - the domain's finding schema.
 * @returns the output schema.
 */
export function citationVerifyOutputSchema<const TSchema>(findingSchema: TSchema): {
  readonly type: 'object'
  readonly additionalProperties: false
  readonly properties: {
    readonly findings: { readonly type: 'array'; readonly required: true; readonly items: TSchema }
    readonly blocked: (typeof CITATION_REPORT_PROPERTIES)['blocked']
    readonly counts: (typeof CITATION_REPORT_PROPERTIES)['counts']
    readonly unrecognized: (typeof CITATION_REPORT_PROPERTIES)['unrecognized']
  }
} {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: { type: 'array', required: true, items: findingSchema },
      ...CITATION_REPORT_PROPERTIES,
    },
  } as const
}

/**
 * Build the render callback every citation-verify tool declares.
 * @param report - renders the domain's full report from the tool output.
 * @returns the render callback.
 */
export function citationVerifyRender<TFinding>(
  report: (findings: TFinding[], blocked: boolean, unrecognized: string[]) => string,
): (args: unknown, value: { findings: TFinding[]; blocked: boolean; unrecognized: string[] }) => Array<{ type: 'text'; text: string }> {
  return (_args, value) => [{ type: 'text', text: report(value.findings, value.blocked, value.unrecognized) }]
}

/**
 * Build the execute callback every citation-verify tool declares.
 * @param run - runs the domain's verification and returns its output value.
 * @returns the execute callback, forwarding the caller's cancellation signal.
 */
export function citationVerifyExecute<TArgs, TOutput>(
  run: (args: TArgs, signal: AbortSignal) => TOutput | Promise<TOutput>,
): (args: TArgs, exec: { readonly signal: AbortSignal }) => Promise<TOutput> {
  return (args, exec) => Promise.resolve(run(args, exec.signal))
}

/**
 * Project collected findings into a citation-verify tool output value.
 * @param input - the findings, their projection, the counter, and the unresolved fragments.
 * @returns the tool output value.
 */
export function citationVerifyReport<TFinding extends { decision: string }, TProjected extends { policy: string }, TCounts>(input: {
  findings: readonly TFinding[]
  project: (finding: TFinding) => TProjected
  count: (findings: TProjected[]) => TCounts
  unrecognized: () => string[]
}): { findings: TProjected[]; blocked: boolean; counts: TCounts; unrecognized: string[] } {
  const projected = input.findings.map(finding => input.project(finding))
  return {
    findings: projected,
    blocked: projected.some(finding => finding.policy === 'block'),
    counts: input.count(projected),
    unrecognized: input.unrecognized(),
  }
}

/**
 * The options every citation-verify tool passes to `defineTool`.
 * @param input - the domain's tool name, description, schema, report, and run function.
 * @returns the tool options, ready for `defineTool`.
 */
export function citationVerifyToolOptions<
  TValue extends { findings: TFinding[]; blocked: boolean; unrecognized: string[] },
  TFinding,
  TFindingSchema,
  TArgs,
>(input: {
  /** Tool name as the model sees it. */
  name: string
  /** Tool description as the model sees it. */
  description: string
  /** Example references for the domain, shown in the parameter schema. */
  referenceExample: string
  /** The domain's finding schema. */
  findingSchema: TFindingSchema
  /** Renders the domain's full report from the tool output. */
  report: (findings: TFinding[], blocked: boolean, unrecognized: string[]) => string
  /** Runs the domain's verification against the caller's cancellation signal. */
  run: (args: TArgs, signal: AbortSignal) => TValue | Promise<TValue>
}): {
  name: string
  description: string
  parameters: ReturnType<typeof citationVerifyParameters>
  output: {
    schema: ReturnType<typeof citationVerifyOutputSchema<TFindingSchema>>
    render: (args: unknown, value: { findings: TFinding[]; blocked: boolean; unrecognized: string[] }) => { type: 'text'; text: string }[]
  }
  execute: (args: TArgs, exec: { readonly signal: AbortSignal }) => Promise<TValue>
} {
  return {
    name: input.name,
    description: input.description,
    parameters: citationVerifyParameters(input.referenceExample),
    output: {
      schema: citationVerifyOutputSchema(input.findingSchema),
      render: citationVerifyRender(input.report),
    },
    execute: citationVerifyExecute(input.run),
  }
}

/** One row of the citation report table. */
export type CitationReportRow<TDecision extends string, TPolicy extends string> = {
  /** The citation as it should be shown. */
  label: string
  /** How the citation was decided. */
  decision: TDecision
  /** How this deployment treats the decision. */
  policy: TPolicy
  /** Why the decision was reached. */
  reason: string
}

/**
 * Render the opening lines of a citation-verify tool report.
 * @param findings - the findings to render.
 * @param unrecognized - citation-like fragments the parser did not resolve.
 * @param labelOf - renders one finding's citation label.
 * @param renderRows - renders the decision table.
 * @returns the report lines, before the domain's own trailing notes.
 */
export function citationReportLines<
  TFinding extends { decision: TDecision; policy: TPolicy; reason: string },
  TDecision extends string,
  TPolicy extends string,
>(
  findings: readonly TFinding[],
  unrecognized: readonly string[],
  labelOf: (finding: TFinding) => string,
  renderRows: (rows: CitationReportRow<TDecision, TPolicy>[]) => string,
): string[] {
  const lines = [renderRows(findings.map(finding => ({
    label: labelOf(finding),
    decision: finding.decision,
    policy: finding.policy,
    reason: finding.reason,
  })))]
  if (unrecognized.length > 0) {
    lines.push('', `文本中仍有 ${unrecognized.length} 处形如法条引用的片段未被识别，未参与判定：${unrecognized.join('、')}。请改写为完整引用或另行核验。`)
  }
  return lines
}
