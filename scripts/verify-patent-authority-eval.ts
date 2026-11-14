/**
 * 权威性评测。
 *
 * 对照 `assets/authority/authority-eval-tasks.yaml` 的三十个基准任务：应当引用的
 * 条文必须被索引判为成立，错误口径必须得到登记的拒答决定，位阶按
 * `authority-ranks.yaml` 取先。评测不调用模型。
 *
 * 用法：`pnpm exec tsx scripts/verify-patent-authority-eval.ts [--check|--write]`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { load as loadYaml } from 'js-yaml'

import {
  loadLegalLawBaselines,
  parseLegalLawReference,
  verifyLegalCitation,
} from '@deepseek-ai/dsh-legal-law'
import type { LegalLawBaseline, LegalLawName, LegalLawReference } from '@deepseek-ai/dsh-legal-law'
import { loadLawBaselines, parseLawReference, verifyCitation } from '@deepseek-ai/dsh-patent-law'
import type { LawBaseline, LawName, LawReference } from '@deepseek-ai/dsh-patent-law'

import { parseAuthorityBaseline, AUTHORITY_BASELINE_PATH, AUTHORITY_RANKS_PATH } from './patent-authority-metrics.ts'

const ROOT = join(import.meta.dirname, '..')

export const AUTHORITY_EVAL_TASKS_PATH = 'packages/patent/patent-law/assets/authority/authority-eval-tasks.yaml'
export const AUTHORITY_EVAL_REPORT_PATH = 'reports/patent-authority-eval.md'

const CITATION_ACCURACY_MINIMUM = 0.98
const TASK_COUNT = 30
const TASKS_PER_CASE_TYPE = 5

const PROBE_ROLES = ['required', 'currency', 'refusal'] as const
const PROBE_EXPECTATIONS = ['valid', 'mismatch', 'unmatched', 'out-of-range', 'not-indexed', 'unverified', 'unparsed'] as const
const PROBE_INDEXES = ['patent-law', 'legal-law'] as const
const RANK_RULES = [
  'higher-authority-wins',
  'special-provision-wins',
  'later-provision-wins',
  'guideline-never-overrides-statute',
] as const

type ProbeRole = (typeof PROBE_ROLES)[number]
type ProbeExpect = (typeof PROBE_EXPECTATIONS)[number]
type ProbeIndex = (typeof PROBE_INDEXES)[number]

/** One citation the scorer runs. */
export type EvalProbe = {
  raw: string
  proposition?: string
  revision?: string
  index: ProbeIndex
  role: ProbeRole
  expect: ProbeExpect
  article?: number
  paragraph?: number
  item?: number
  path?: string
}

/** One side of a rank conflict. */
export type RankClaim = {
  raw: string
  proposition: string
  article?: number
  paragraph?: number
  item?: number
  path?: string
}

/** Two citations and the source id that must win. */
export type EvalRank = {
  rule: (typeof RANK_RULES)[number]
  expectWinner: string
  claims: RankClaim[]
}

/** One golden task. */
export type EvalTask = {
  id: string
  caseType: string
  title: string
  answer: string
  forbidden: string[]
  probes: EvalProbe[]
  rank?: EvalRank
}

/** The task inventory. */
export type EvalDocument = {
  version: string
  verifiedOn: string
  phase0: { goldenTasks: number; knownCitationErrors: number }
  tasks: EvalTask[]
}

/** Indexes and the rank table the scorer reads. */
export type EvalContext = {
  patent: Map<LawName, LawBaseline>
  legal: Map<LegalLawName, LegalLawBaseline>
  sourceIdByLaw: Map<string, string>
  caseTypes: Array<{ id: string; order: string[]; reference: string[] }>
}

/** One probe after it has been decided. */
export type ScoredProbe = {
  taskId: string
  raw: string
  role: ProbeRole
  expect: ProbeExpect
  actual: string
  locatorOk: boolean
}

/** Counts and the per-probe record. */
export type EvalScore = {
  verifiedOn: string
  phase0: { goldenTasks: number; knownCitationErrors: number }
  taskCount: number
  citationHit: number
  citationTotal: number
  supportHit: number
  supportTotal: number
  currencyHit: number
  currencyTotal: number
  refusalHit: number
  refusalTotal: number
  rankHit: number
  rankTotal: number
  wrongFormulations: number
  probes: ScoredProbe[]
  tasks: Array<{
    id: string
    caseType: string
    title: string
    citation: string
    support: string
    currency: string
    refusal: string
    rank: string
    wrong: number
  }>
}

/**
 * @param value - an unknown YAML node.
 * @returns whether the node is a plain mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param message - what is wrong with the inventory.
 * @returns an error that names the inventory file.
 */
function fail(message: string): Error {
  return new Error(`${AUTHORITY_EVAL_TASKS_PATH}: ${message}`)
}

/**
 * @param value - a YAML node that should be a string.
 * @param where - the field path used in the error.
 * @returns the string.
 */
function readString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw fail(`${where} 必须是非空字符串`)
  return value
}

/**
 * @param value - a YAML node that should be an integer, when present.
 * @param where - the field path used in the error.
 * @returns the integer, or undefined when the field is absent.
 */
function readOptionalInt(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(`${where} 必须是整数`)
  return value
}

/**
 * @param record - a probe or rank-claim mapping.
 * @param where - the field path used in the error.
 * @returns the optional locator and proposition fields.
 */
function readLocator(record: Record<string, unknown>, where: string): Pick<EvalProbe, 'proposition' | 'revision' | 'article' | 'paragraph' | 'item' | 'path'> {
  const proposition = record.proposition === undefined ? undefined : readString(record.proposition, `${where}.proposition`)
  const revision = record.revision === undefined ? undefined : readString(record.revision, `${where}.revision`)
  const path = record.path === undefined ? undefined : readString(record.path, `${where}.path`)
  const article = readOptionalInt(record.article, `${where}.article`)
  const paragraph = readOptionalInt(record.paragraph, `${where}.paragraph`)
  const item = readOptionalInt(record.item, `${where}.item`)
  return {
    ...(proposition === undefined ? {} : { proposition }),
    ...(revision === undefined ? {} : { revision }),
    ...(path === undefined ? {} : { path }),
    ...(article === undefined ? {} : { article }),
    ...(paragraph === undefined ? {} : { paragraph }),
    ...(item === undefined ? {} : { item }),
  }
}

/**
 * @param value - one probe node.
 * @param where - the field path used in the error.
 * @returns the probe.
 */
function readProbe(value: unknown, where: string): EvalProbe {
  if (!isRecord(value)) throw fail(`${where} 必须是映射`)
  const role = readString(value.role, `${where}.role`)
  if (!PROBE_ROLES.includes(role as ProbeRole)) throw fail(`${where}.role 无法识别`)
  const expect = readString(value.expect, `${where}.expect`)
  if (!PROBE_EXPECTATIONS.includes(expect as ProbeExpect)) throw fail(`${where}.expect 无法识别`)
  const indexText = value.index === undefined ? 'patent-law' : readString(value.index, `${where}.index`)
  if (!PROBE_INDEXES.includes(indexText as ProbeIndex)) throw fail(`${where}.index 无法识别`)
  return {
    raw: readString(value.raw, `${where}.raw`),
    index: indexText as ProbeIndex,
    role: role as ProbeRole,
    expect: expect as ProbeExpect,
    ...readLocator(value, where),
  }
}

/**
 * @param value - the rank node, when the task has one.
 * @param where - the field path used in the error.
 * @returns the rank block.
 */
function readRank(value: unknown, where: string): EvalRank {
  if (!isRecord(value)) throw fail(`${where} 必须是映射`)
  const rule = readString(value.rule, `${where}.rule`)
  if (!RANK_RULES.includes(rule as EvalRank['rule'])) throw fail(`${where}.rule 无法识别`)
  if (!Array.isArray(value.claims) || value.claims.length !== 2) throw fail(`${where}.claims 必须是两项`)
  const claims = value.claims.map((claim, index) => {
    if (!isRecord(claim)) throw fail(`${where}.claims[${index}] 必须是映射`)
    return {
      raw: readString(claim.raw, `${where}.claims[${index}].raw`),
      proposition: readString(claim.proposition, `${where}.claims[${index}].proposition`),
      ...readLocator(claim, `${where}.claims[${index}]`),
    }
  })
  return { rule: rule as EvalRank['rule'], expectWinner: readString(value.expectWinner, `${where}.expectWinner`), claims }
}

/**
 * Parse the task inventory.
 * @param text - the YAML file contents.
 * @returns the document.
 */
export function loadAuthorityEval(text: string): EvalDocument {
  const root = loadYaml(text)
  if (!isRecord(root)) throw fail('根节点必须是映射')
  const phase0 = root.phase0
  if (!isRecord(phase0)) throw fail('phase0 必须是映射')
  const goldenTasks = phase0.goldenTasks
  const knownCitationErrors = phase0.knownCitationErrors
  if (goldenTasks !== 0) throw fail('phase0.goldenTasks 必须是 0')
  if (knownCitationErrors !== 5) throw fail('phase0.knownCitationErrors 必须是 5')
  if (!Array.isArray(root.tasks)) throw fail('tasks 必须是数组')
  const tasks = root.tasks.map((task, index) => {
    const where = `tasks[${index}]`
    if (!isRecord(task)) throw fail(`${where} 必须是映射`)
    const forbidden = task.forbidden
    if (!Array.isArray(forbidden) || forbidden.some(item => typeof item !== 'string' || item.trim() === '')) {
      throw fail(`${where}.forbidden 必须是非空字符串数组`)
    }
    if (!Array.isArray(task.probes) || task.probes.length === 0) throw fail(`${where}.probes 必须是非空数组`)
    return {
      id: readString(task.id, `${where}.id`),
      caseType: readString(task.caseType, `${where}.caseType`),
      title: readString(task.title, `${where}.title`),
      answer: readString(task.answer, `${where}.answer`),
      forbidden,
      probes: task.probes.map((probe, probeIndex) => readProbe(probe, `${where}.probes[${probeIndex}]`)),
      ...(task.rank === undefined ? {} : { rank: readRank(task.rank, `${where}.rank`) }),
    }
  })
  return {
    version: readString(root.version, 'version'),
    verifiedOn: readString(root.verifiedOn, 'verifiedOn'),
    phase0: { goldenTasks, knownCitationErrors },
    tasks,
  }
}

/**
 * Load the indexes, the source ids, and the rank table.
 * @returns the scorer context.
 */
export function loadEvalContext(): EvalContext {
  const baseline = parseAuthorityBaseline(readFileSync(join(ROOT, AUTHORITY_BASELINE_PATH), 'utf8'))
  const ranksText = readFileSync(join(ROOT, AUTHORITY_RANKS_PATH), 'utf8')
  const ranksRoot = loadYaml(ranksText)
  if (!isRecord(ranksRoot) || !Array.isArray(ranksRoot.caseTypes)) throw new Error(`${AUTHORITY_RANKS_PATH}: caseTypes 必须是数组`)
  const caseTypes = ranksRoot.caseTypes.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${AUTHORITY_RANKS_PATH}: caseTypes[${index}] 必须是映射`)
    const readIds = (field: string): string[] => {
      const value = entry[field]
      if (value === undefined) return []
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
        throw new Error(`${AUTHORITY_RANKS_PATH}: caseTypes[${index}].${field} 必须是字符串数组`)
      }
      return value.filter((item): item is string => typeof item === 'string')
    }
    const id = entry.id
    if (typeof id !== 'string' || id.trim() === '') throw new Error(`${AUTHORITY_RANKS_PATH}: caseTypes[${index}].id 必须是非空字符串`)
    return { id, order: readIds('order'), reference: readIds('reference') }
  })
  return {
    patent: loadLawBaselines(),
    legal: loadLegalLawBaselines(),
    sourceIdByLaw: new Map(baseline.sources.map(source => [source.law, source.id])),
    caseTypes,
  }
}

type Located = {
  kind: 'law-article' | 'guideline-section'
  article?: number
  paragraph?: number
  item?: number
  path?: string
  law: string
}

/**
 * @param reference - a parsed patent or legal citation.
 * @returns the fields a locator compares.
 */
function locate(reference: LawReference | LegalLawReference): Located {
  if (reference.kind === 'guideline-section') return { kind: 'guideline-section', path: reference.path, law: reference.law }
  return {
    kind: 'law-article',
    law: reference.law,
    article: reference.article,
    ...(reference.paragraph === undefined ? {} : { paragraph: reference.paragraph }),
    ...(reference.item === undefined ? {} : { item: reference.item }),
  }
}

/**
 * @param probe - the expected locator.
 * @param located - the parsed citation.
 * @returns whether every recorded field matches.
 */
function locatorMatches(probe: Pick<EvalProbe, 'article' | 'paragraph' | 'item' | 'path'>, located: Located): boolean {
  if (probe.path !== undefined && located.path !== probe.path) return false
  if (probe.article !== undefined && located.article !== probe.article) return false
  if (probe.paragraph !== undefined && located.paragraph !== probe.paragraph) return false
  if (probe.item !== undefined && located.item !== probe.item) return false
  return true
}

/**
 * Decide one citation.
 * @param raw - the citation text.
 * @param index - which index decides.
 * @param proposition - the proposition, when the probe has one.
 * @param revision - the guideline revision, when the probe names one.
 * @param ctx - the loaded indexes.
 * @returns the decision name, `unparsed` when the text is not a citation, and the located fields.
 */
function decide(
  raw: string,
  index: ProbeIndex,
  proposition: string | undefined,
  revision: string | undefined,
  ctx: EvalContext,
): { decision: string; located: Located | null } {
  const options = {
    ...(proposition === undefined ? {} : { proposition }),
    ...(revision === undefined ? {} : { revision }),
  }
  if (index === 'legal-law') {
    const reference = parseLegalLawReference(raw)
    if (reference === null) return { decision: 'unparsed', located: null }
    return { decision: verifyLegalCitation(reference, ctx.legal, options).decision, located: locate(reference) }
  }
  const reference = parseLawReference(raw)
  if (reference === null) return { decision: 'unparsed', located: null }
  return { decision: verifyCitation(reference, ctx.patent, options).decision, located: locate(reference) }
}

/**
 * Place a source on a case type's rank table.
 * @param row - the case type row.
 * @param sourceId - the baseline source id.
 * @returns the band (`order` before `reference`) and the index inside that band.
 */
function placement(row: { order: string[]; reference: string[] }, sourceId: string): { band: number; index: number } | null {
  const orderIndex = row.order.indexOf(sourceId)
  if (orderIndex >= 0) return { band: 0, index: orderIndex }
  const referenceIndex = row.reference.indexOf(sourceId)
  if (referenceIndex >= 0) return { band: 1, index: referenceIndex }
  return null
}

/**
 * @param hit - matching probes.
 * @param total - probes of that role.
 * @returns a `命中/合计` cell, or a dash when the task has none.
 */
function cell(hit: number, total: number): string {
  if (total === 0) return '—'
  return `${hit}/${total}`
}

/**
 * @param hit - matching probes.
 * @param total - probes of that metric.
 * @returns the rate, or 0 when there is nothing to score.
 */
function rate(hit: number, total: number): number {
  if (total === 0) return 0
  return hit / total
}

/**
 * Score every task.
 * @param doc - the inventory.
 * @param ctx - the indexes and the rank table.
 * @returns the counts. Structural problems are reported separately.
 */
export function scoreAuthorityEval(doc: EvalDocument, ctx: EvalContext): EvalScore {
  const probes: ScoredProbe[] = []
  const tasks: EvalScore['tasks'] = []
  let citationHit = 0
  let citationTotal = 0
  let supportHit = 0
  let supportTotal = 0
  let currencyHit = 0
  let currencyTotal = 0
  let refusalHit = 0
  let refusalTotal = 0
  let rankHit = 0
  let rankTotal = 0
  let wrongFormulations = 0

  for (const task of doc.tasks) {
    let taskCitationHit = 0
    let taskCitationTotal = 0
    let taskSupportHit = 0
    let taskSupportTotal = 0
    let taskCurrencyHit = 0
    let taskCurrencyTotal = 0
    let taskRefusalHit = 0
    let taskRefusalTotal = 0
    let taskWrong = 0
    for (const phrase of task.forbidden) {
      if (task.answer.includes(phrase)) {
        taskWrong += 1
        wrongFormulations += 1
      }
    }
    for (const probe of task.probes) {
      const result = decide(probe.raw, probe.index, probe.proposition, probe.revision, ctx)
      const locatorOk = result.located !== null && locatorMatches(probe, result.located)
      const matched = result.decision === probe.expect && locatorOk
      probes.push({ taskId: task.id, raw: probe.raw, role: probe.role, expect: probe.expect, actual: result.decision, locatorOk })
      if (probe.role === 'required') {
        citationTotal += 1
        taskCitationTotal += 1
        if (probe.proposition !== undefined) {
          supportTotal += 1
          taskSupportTotal += 1
        }
        if (matched && probe.expect === 'valid') {
          citationHit += 1
          taskCitationHit += 1
          if (probe.proposition !== undefined) {
            supportHit += 1
            taskSupportHit += 1
          }
        }
      } else if (probe.role === 'currency') {
        currencyTotal += 1
        taskCurrencyTotal += 1
        if (matched) {
          currencyHit += 1
          taskCurrencyHit += 1
        }
      } else {
        refusalTotal += 1
        taskRefusalTotal += 1
        if (matched) {
          refusalHit += 1
          taskRefusalHit += 1
        }
        if (result.decision === 'valid') {
          taskWrong += 1
          wrongFormulations += 1
        }
      }
      if (probe.role === 'required' && !task.answer.includes(probe.raw)) {
        taskWrong += 1
        wrongFormulations += 1
      }
    }

    let rankCell = '—'
    if (task.rank !== undefined) {
      rankTotal += 1
      const row = ctx.caseTypes.find(candidate => candidate.id === task.caseType)
      const placed: Array<{ band: number; index: number; sourceId: string }> = []
      let claimsValid = row !== undefined
      for (const claim of task.rank.claims) {
        const result = decide(claim.raw, 'patent-law', claim.proposition, undefined, ctx)
        const locatorOk = result.located !== null && locatorMatches(claim, result.located)
        if (result.decision !== 'valid' || !locatorOk || result.located === null || row === undefined) {
          claimsValid = false
          continue
        }
        const sourceId = ctx.sourceIdByLaw.get(result.located.law)
        const slot = sourceId === undefined ? null : placement(row, sourceId)
        if (sourceId === undefined || slot === null) claimsValid = false
        else placed.push({ ...slot, sourceId })
        if (!task.answer.includes(claim.raw)) {
          taskWrong += 1
          wrongFormulations += 1
        }
      }
      placed.sort((left, right) => left.band - right.band || left.index - right.index)
      const first = placed[0]
      const second = placed[1]
      let winner: string | undefined
      if (
        placed.length === task.rank.claims.length
        && first !== undefined
        && second !== undefined
        && (first.band !== second.band || first.index !== second.index)
      ) {
        winner = first.sourceId
      }
      if (claimsValid && winner === task.rank.expectWinner) {
        rankHit += 1
        rankCell = task.rank.expectWinner
      } else {
        rankCell = '不符'
      }
    }

    tasks.push({
      id: task.id,
      caseType: task.caseType,
      title: task.title,
      citation: cell(taskCitationHit, taskCitationTotal),
      support: cell(taskSupportHit, taskSupportTotal),
      currency: cell(taskCurrencyHit, taskCurrencyTotal),
      refusal: cell(taskRefusalHit, taskRefusalTotal),
      rank: rankCell,
      wrong: taskWrong,
    })
  }

  return {
    verifiedOn: doc.verifiedOn,
    phase0: doc.phase0,
    taskCount: doc.tasks.length,
    citationHit,
    citationTotal,
    supportHit,
    supportTotal,
    currencyHit,
    currencyTotal,
    refusalHit,
    refusalTotal,
    rankHit,
    rankTotal,
    wrongFormulations,
    probes,
    tasks,
  }
}

/**
 * @param score - a scored run.
 * @returns citation accuracy.
 */
export function citationAccuracy(score: EvalScore): number {
  return rate(score.citationHit, score.citationTotal)
}

/**
 * Problems that fail the phase exit.
 * @param doc - the inventory.
 * @param score - the scored run.
 * @param ctx - the rank table used to require one row per case type.
 * @returns the problems, empty when the inventory meets the exit.
 */
export function evalProblems(doc: EvalDocument, score: EvalScore, ctx: EvalContext): string[] {
  const problems: string[] = []
  if (doc.tasks.length !== TASK_COUNT) problems.push(`任务必须是 ${TASK_COUNT} 个，实际 ${doc.tasks.length} 个`)
  const ids = new Set<string>()
  for (const task of doc.tasks) {
    if (ids.has(task.id)) problems.push(`任务 id 重复：${task.id}`)
    ids.add(task.id)
    if (!task.probes.some(probe => probe.role === 'required')) problems.push(`${task.id} 没有应当引用的条文`)
  }
  for (const row of ctx.caseTypes) {
    const count = doc.tasks.filter(task => task.caseType === row.id).length
    if (count !== TASKS_PER_CASE_TYPE) problems.push(`案型 ${row.id} 必须有 ${TASKS_PER_CASE_TYPE} 个任务，实际 ${count} 个`)
  }
  const known = new Set(ctx.caseTypes.map(row => row.id))
  for (const task of doc.tasks) {
    if (!known.has(task.caseType)) problems.push(`${task.id} 的案型 ${task.caseType} 不在位阶表中`)
  }
  if (score.citationTotal === 0) problems.push('没有应当引用的条文')
  if (score.supportTotal === 0) problems.push('没有带命题的引用')
  if (score.currencyTotal === 0) problems.push('没有时效探针')
  if (score.refusalTotal === 0) problems.push('没有拒答探针')
  if (score.rankTotal !== ctx.caseTypes.length) problems.push(`位阶裁决必须覆盖每个案型，实际 ${score.rankTotal} 项`)
  if (citationAccuracy(score) < CITATION_ACCURACY_MINIMUM) {
    problems.push(`引用正确率 ${formatRate(citationAccuracy(score))} 低于 ${(CITATION_ACCURACY_MINIMUM * 100).toFixed(0)}%`)
  }
  if (score.wrongFormulations !== 0) problems.push(`错误口径 ${score.wrongFormulations} 处，必须为零`)
  for (const probe of score.probes) {
    if (probe.actual !== probe.expect || !probe.locatorOk) {
      problems.push(`${probe.taskId} 的「${probe.raw}」期望 ${probe.expect}，实际 ${probe.actual}${probe.locatorOk ? '' : '，定位不符'}`)
    }
  }
  for (const task of score.tasks) {
    if (task.rank === '不符') problems.push(`${task.id} 的位阶裁决与位阶表不一致`)
  }
  for (const task of doc.tasks) {
    for (const phrase of task.forbidden) {
      if (task.answer.includes(phrase)) problems.push(`${task.id} 的答案含有错误口径「${phrase}」`)
    }
    for (const probe of task.probes) {
      if (probe.role === 'required' && !task.answer.includes(probe.raw)) {
        problems.push(`${task.id} 的答案没有写上应当引用的「${probe.raw}」`)
      }
    }
    if (task.rank !== undefined) {
      for (const claim of task.rank.claims) {
        if (!task.answer.includes(claim.raw)) problems.push(`${task.id} 的答案没有写上参与位阶裁决的「${claim.raw}」`)
      }
    }
  }
  return problems
}

/**
 * @param value - a rate from 0 to 1.
 * @returns the percent text used in the report.
 */
function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * Render the reproducible report.
 * @param score - the scored run.
 * @returns the Markdown report.
 */
export function renderAuthorityEvalReport(score: EvalScore): string {
  const lines = [
    '# 权威性评测',
    '',
    `任务清单 \`${AUTHORITY_EVAL_TASKS_PATH}\`，核对于 ${score.verifiedOn}。${score.taskCount} 个任务，六类案型各五个。评测不调用模型：条文引用交给索引核验，位阶按 \`${AUTHORITY_RANKS_PATH}\` 取先。`,
    '',
    '## 与阶段 0 对比',
    '',
    '| 指标 | 阶段 0 | 本次 |',
    '| --- | --- | --- |',
    `| 基准任务 | ${score.phase0.goldenTasks} | ${score.taskCount} |`,
    `| 已知引用错误 | ${score.phase0.knownCitationErrors} | ${score.wrongFormulations} |`,
    `| 引用正确率 | 未测量 | ${formatRate(rate(score.citationHit, score.citationTotal))} |`,
    `| 命题支撑率 | 未测量 | ${formatRate(rate(score.supportHit, score.supportTotal))} |`,
    `| 时效正确率 | 未测量 | ${formatRate(rate(score.currencyHit, score.currencyTotal))} |`,
    `| 拒答率 | 未测量 | ${formatRate(rate(score.refusalHit, score.refusalTotal))} |`,
    `| 位阶冲突裁决正确率 | 未测量 | ${formatRate(rate(score.rankHit, score.rankTotal))} |`,
    '',
    '## 分项',
    '',
    '| 指标 | 命中 | 合计 | 比率 |',
    '| --- | --- | --- | --- |',
    `| 引用正确 | ${score.citationHit} | ${score.citationTotal} | ${formatRate(rate(score.citationHit, score.citationTotal))} |`,
    `| 命题支撑 | ${score.supportHit} | ${score.supportTotal} | ${formatRate(rate(score.supportHit, score.supportTotal))} |`,
    `| 时效正确 | ${score.currencyHit} | ${score.currencyTotal} | ${formatRate(rate(score.currencyHit, score.currencyTotal))} |`,
    `| 拒答 | ${score.refusalHit} | ${score.refusalTotal} | ${formatRate(rate(score.refusalHit, score.refusalTotal))} |`,
    `| 位阶裁决 | ${score.rankHit} | ${score.rankTotal} | ${formatRate(rate(score.rankHit, score.rankTotal))} |`,
    `| 错误口径 | ${score.wrongFormulations} | 0 | ${score.wrongFormulations === 0 ? '0' : String(score.wrongFormulations)} |`,
    '',
    '## 任务',
    '',
    '| 任务 | 案型 | 引用 | 命题 | 时效 | 拒答 | 位阶 | 错误口径 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const task of score.tasks) {
    lines.push(`| ${task.id} | ${task.caseType} | ${task.citation} | ${task.support} | ${task.currency} | ${task.refusal} | ${task.rank} | ${task.wrong} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Score the packaged inventory.
 * @returns the score and the problems.
 */
export function checkPackagedAuthorityEval(): { score: EvalScore; problems: string[] } {
  const doc = loadAuthorityEval(readFileSync(join(ROOT, AUTHORITY_EVAL_TASKS_PATH), 'utf8'))
  const ctx = loadEvalContext()
  const score = scoreAuthorityEval(doc, ctx)
  return { score, problems: evalProblems(doc, score, ctx) }
}

/**
 * Print the report, and exit non-zero when the exit conditions fail.
 * `--check` compares the committed report. `--write` replaces it.
 */
function main(): void {
  const args = process.argv.slice(2)
  const doc = loadAuthorityEval(readFileSync(join(ROOT, AUTHORITY_EVAL_TASKS_PATH), 'utf8'))
  const ctx = loadEvalContext()
  const score = scoreAuthorityEval(doc, ctx)
  const problems = evalProblems(doc, score, ctx)
  const markdown = renderAuthorityEvalReport(score)
  const reportPath = join(ROOT, AUTHORITY_EVAL_REPORT_PATH)
  if (args.includes('--check')) {
    const existing = readFileSync(reportPath, 'utf8')
    if (existing !== markdown) problems.push(`${AUTHORITY_EVAL_REPORT_PATH} 与复跑结果不一致`)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exitCode = 1
    return
  }
  if (args.includes('--write')) writeFileSync(reportPath, markdown)
  console.log(markdown)
}

if (process.argv[1]?.endsWith('verify-patent-authority-eval.ts')) main()
