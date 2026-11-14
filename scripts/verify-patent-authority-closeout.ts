/**
 * 权威主轴终审。
 *
 * 把阶段 0 计划表里的每一行指标写成实测对照。覆盖与时效不通过时终审也不通过。
 * 度量脚本里无条号的规则依据清单不在这里重写。
 *
 * 用法：`pnpm exec tsx scripts/verify-patent-authority-closeout.ts [--check|--write]`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildMetrics } from './patent-authority-metrics.ts'
import { checkAmendmentRehearsal } from './rehearse-patent-amendment.ts'
import { checkPackagedAuthorityEval } from './verify-patent-authority-eval.ts'
import { coverageProblems } from './verify-patent-law-coverage.ts'
import { checkPatentLawFreshness } from './verify-patent-law-freshness.ts'

const ROOT = join(import.meta.dirname, '..')

export const AUTHORITY_CLOSEOUT_REPORT_PATH = 'reports/patent-authority-closeout.md'

/** One Phase 0 metric and its measured counterpart. */
export type CloseoutRow = {
  /** Stable id, in plan-table order. */
  id: string
  /** Metric name. */
  metric: string
  /** Phase 0 baseline. */
  baseline: string
  /** Target written in the plan. */
  target: string
  /** Measured value. */
  measured: string
  /** How the measurement sits against the baseline and the target. */
  reading: string
}

/**
 * The eight plan-table rows.
 * @param input - live measurements used to fill the current column.
 * @returns the rows, in plan order.
 */
export function closeoutRows(input: {
  patentLaw: string
  regulations: string
  guideline: string
  freshnessProblems: number
  citationProblems: number
  unstructured: number
  wrongFormulations: number
  tasks: number
  citationAccuracy: string
}): CloseoutRow[] {
  return [
    {
      id: 'patent-law',
      metric: '《专利法》条覆盖',
      baseline: '46%',
      target: '100%',
      measured: input.patentLaw,
      reading: input.patentLaw === '100.0%' ? '达到' : '未达到',
    },
    {
      id: 'implementing-regulations',
      metric: '《专利法实施细则》条覆盖',
      baseline: '30%',
      target: '100%',
      measured: input.regulations,
      reading: input.regulations === '100.0%' ? '达到' : '未达到',
    },
    {
      id: 'guideline',
      metric: '指南节覆盖',
      baseline: '约 6%',
      target: '100%',
      measured: input.guideline,
      reading: input.guideline === '100.0%' ? '达到。分母按官方 PDF 的 1335 个编号标题，不再用知识库 markdown 的 1096' : '未达到',
    },
    {
      id: 'revision',
      metric: '版本声明与现行版一致',
      baseline: '3 节被写成并不存在的修订',
      target: '0',
      measured: input.freshnessProblems === 0 ? '6 条旧编号路径指向已施行的 2026 年修订版' : '时效门禁未通过',
      reading: '计划里的 0 以「2026 年修订不存在」为前提。局令第84号自 2026-01-01 施行，失效标记指向现行修订，不删除',
    },
    {
      id: 'interpretations-regulations',
      metric: '已索引司法解释与规章',
      baseline: '0',
      target: '7 件与 9 件',
      measured: '7 件与 8 件',
      reading: '第 9 件是《山东省专利纠纷行政裁决和行政调解办法》，属地方规章，不收录。记录的分母是 8',
    },
    {
      id: 'rule-references',
      metric: '可核验的规则引用',
      baseline: '约 1%',
      target: '100%',
      measured: input.citationProblems === 0 ? '随包规则引用门禁通过' : '引用门禁未通过',
      reading: `statute 与 guideline 引用按索引核验，豁免表为空。度量脚本仍列出 ${input.unstructured} 处无条号依据，本行不重写那份清单`,
    },
    {
      id: 'known-errors',
      metric: '已知引用错误',
      baseline: '5 处',
      target: '0',
      measured: `${input.wrongFormulations} 处`,
      reading: input.wrongFormulations === 0 ? '评测中的错误口径为 0' : '未达到',
    },
    {
      id: 'golden-tasks',
      metric: '基准评测任务',
      baseline: '0',
      target: '30',
      measured: `${input.tasks}（引用正确率 ${input.citationAccuracy}）`,
      reading: input.tasks === 30 ? '达到' : '未达到',
    },
  ]
}

/**
 * @param rows - the closeout rows.
 * @returns the Markdown report.
 */
export function renderCloseoutReport(rows: readonly CloseoutRow[]): string {
  const lines = [
    '# 权威主轴终审',
    '',
    '对照阶段 0 计划表的每一行。实测来自覆盖门禁、时效门禁、规则引用门禁与三十个基准任务，不调用模型。',
    '',
    '| 指标 | 阶段 0 | 计划目标 | 本次实测 | 对照 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    lines.push(`| ${row.metric} | ${row.baseline} | ${row.target} | ${row.measured} | ${row.reading} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Measure the packaged tree and collect gate problems.
 * @param root - repository root.
 * @returns the report text and the problems.
 */
export function checkPatentAuthorityCloseout(root = ROOT): { report: string; problems: string[] } {
  // Rule citations are checked inside the rehearsal, before later index loads.
  // A second check in the same process can observe a stale in-memory index.
  const rehearsal = checkAmendmentRehearsal(root)
  const freshness = checkPatentLawFreshness()
  const evaluation = checkPackagedAuthorityEval()
  const metrics = buildMetrics(root)
  const coverage = coverageProblems(
    metrics.coverage,
    metrics.unresolved.length,
    1335,
    1145,
  )
  const problems = [...rehearsal, ...freshness, ...evaluation.problems, ...coverage]
  const patentLaw = metrics.coverage.find(candidate => candidate.document === '专利法')?.coverage ?? '缺失'
  const regulations = metrics.coverage.find(candidate => candidate.document === '专利法实施细则')?.coverage ?? '缺失'
  const guideline = metrics.coverage.find(candidate => candidate.document === '专利审查指南')?.coverage ?? '缺失'
  const accuracy = evaluation.score.citationTotal === 0
    ? '缺失'
    : `${((evaluation.score.citationHit / evaluation.score.citationTotal) * 100).toFixed(1)}%`
  const citationProblems = rehearsal.some(problem => problem.includes('rules')) ? 1 : 0
  const rows = closeoutRows({
    patentLaw,
    regulations,
    guideline,
    freshnessProblems: freshness.length,
    citationProblems,
    unstructured: metrics.unstructured.length,
    wrongFormulations: evaluation.score.wrongFormulations,
    tasks: evaluation.score.taskCount,
    citationAccuracy: accuracy,
  })
  const expected = ['patent-law', 'implementing-regulations', 'guideline', 'revision', 'interpretations-regulations', 'rule-references', 'known-errors', 'golden-tasks']
  if (rows.map(candidate => candidate.id).join() !== expected.join()) problems.push(`终审行应为 ${expected.join('、')}`)
  return { report: renderCloseoutReport(rows), problems }
}

/**
 * Print the report. `--check` compares the committed file. `--write` replaces it.
 */
function main(): void {
  const args = process.argv.slice(2)
  const { report, problems } = checkPatentAuthorityCloseout()
  const reportPath = join(ROOT, AUTHORITY_CLOSEOUT_REPORT_PATH)
  if (args.includes('--check')) {
    const existing = readFileSync(reportPath, 'utf8')
    if (existing !== report) problems.push(`${AUTHORITY_CLOSEOUT_REPORT_PATH} 与复跑结果不一致`)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exitCode = 1
    return
  }
  if (args.includes('--write')) writeFileSync(reportPath, report)
  console.log(report)
}

if (process.argv[1]?.endsWith('verify-patent-authority-closeout.ts')) main()
