/**
 * 修法步骤演练。
 *
 * 用已经落地的 2026 年指南修订走一遍运行手册：沿革记录、索引时效、规则引用、
 * 模板清单、评测任务。缺任何一步就失败。
 *
 * 用法：`pnpm exec tsx scripts/rehearse-patent-amendment.ts`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { checkPackagedAuthorityEval } from './verify-patent-authority-eval.ts'
import { checkPatentLawFreshness, UNVERIFIED_STALE_PATH } from './verify-patent-law-freshness.ts'
import { checkRuleProcedureAlignment } from './verify-patent-rule-alignment.ts'
import { checkPackagedRuleCitations } from './verify-patent-rule-citations.ts'

const ROOT = join(import.meta.dirname, '..')
const CHANGE_RECORD = 'packages/patent/patent-law/assets/authority/guideline-changes-2026.yaml'

/** The five steps of one amendment. */
export const AMENDMENT_STEPS = ['change-record', 'index', 'rules', 'templates', 'evaluation'] as const

/** One amendment step. */
export type AmendmentStep = (typeof AMENDMENT_STEPS)[number]

/**
 * @param failed - steps that did not pass.
 * @returns one problem per failed step, in runbook order.
 */
export function rehearsalProblems(failed: readonly AmendmentStep[]): string[] {
  return AMENDMENT_STEPS.filter(step => failed.includes(step)).map(step => `修法步骤未通过：${step}`)
}

/**
 * @param root - repository root.
 * @returns whether the 2026 change record names the current revision and its renumberings.
 */
function changeRecordReady(root: string): boolean {
  const text = readFileSync(join(root, CHANGE_RECORD), 'utf8')
  return text.includes('revision: 2026 年修订版（2026-01-01 施行）') && text.includes('\nrenames:\n')
}

/**
 * Rehearse the packaged 2026 guideline amendment.
 * @param root - repository root.
 * @returns the failed steps.
 */
export function checkAmendmentRehearsal(root = ROOT): string[] {
  const failed: AmendmentStep[] = []
  if (!changeRecordReady(root)) failed.push('change-record')
  if (checkPatentLawFreshness().length > 0) failed.push('index')
  if (checkPackagedRuleCitations().length > 0) failed.push('rules')
  if (checkRuleProcedureAlignment(root).length > 0) failed.push('templates')
  const evaluation = checkPackagedAuthorityEval()
  const staleProbe = evaluation.score.probes.some(probe =>
    probe.raw.includes(UNVERIFIED_STALE_PATH)
    && probe.expect === 'unverified'
    && probe.actual === 'unverified')
  if (evaluation.problems.length > 0 || !staleProbe) failed.push('evaluation')
  return rehearsalProblems(failed)
}

/**
 * Print the failed steps and exit non-zero when the rehearsal does not pass.
 */
function main(): void {
  const problems = checkAmendmentRehearsal()
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exitCode = 1
    return
  }
  console.log('rehearse-patent-amendment: 沿革、索引、规则、模板、评测五步都在')
}

if (process.argv[1]?.endsWith('rehearse-patent-amendment.ts')) main()
