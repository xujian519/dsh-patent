/**
 * P1-10 campaign orchestration: the per-task pipeline (workspace prep → per
 * arm agent run → prediction collection → local FAIL_TO_PASS verdict), the
 * resume-safe `results.json` merging, concurrency, and the dry-run plan.
 *
 * This is the light-weight local path (P-B): no Docker, per-task venv, local
 * pytest verdict. The runner never retries a *verdict*; it retries an agent
 * process crash once (infra, not evidence).
 *
 * @module @deepseek-ai/dsh-self-evolve-eval/campaign/orchestrate
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errorMessage } from '@deepseek-ai/dsh-value'
import type { EvalTask } from '../types.ts'
import { loadTaskManifest } from '../subset.ts'
import {
  indexSwebenchRows,
  normalizeSwebenchRow,
  readManifestRows,
  type SwebenchRow,
} from './manifest.ts'
import { mergeArmOutcome, type CampaignArm, type PartialTaskOutcome } from './merge.ts'
import { renderEvolvedOverlay } from './overlay.ts'
import {
  collectPrediction,
  prepareTaskWorkspace,
  runAgent,
  verifyVerdict,
  type PreparedWorkspace,
} from './workspace.ts'

/** One planned task entry of a campaign run. */
interface CampaignPlanEntry {
  taskId: string
  repo: string
  baseCommit: string
  arms: CampaignArm[]
}

/**
 * Plan the arm set for every subset task. `both` yields the paired order
 * (baseline first, then evolved) the decision rule assumes.
 *
 * @param tasks - the subset tasks (underlying order preserved).
 * @param armMode - baseline, evolved, or both.
 * @returns the plan entries.
 */
export function planCampaign(tasks: readonly EvalTask[], armMode: CampaignArm | 'both'): CampaignPlanEntry[] {
  const arms: CampaignArm[] = armMode === 'both' ? ['baseline', 'evolved'] : [armMode]
  return tasks.map(task => ({
    taskId: task.instanceId,
    repo: task.repo,
    baseCommit: task.baseCommit,
    arms: [...arms],
  }))
}

/** Interpreter a task venv uses when neither the caller nor its row names one. */
export const DEFAULT_PYTHON_VERSION = '3.11'

/** Options for {@link runCampaign}. */
export interface CampaignOptions {
  manifestPath: string
  subsetPath: string
  resultsPath: string
  statsPath: string
  workDir: string
  armMode: CampaignArm | 'both'
  profile: string
  /** Absolute path to `apps/cli/src/bin.ts`. */
  dshEntry: string
  /** Absolute module specifier for the tsx ESM hook. */
  tsxImport: string
  /** Absolute path to the tsconfig whose `paths` resolve the harness sources. */
  tsconfigPath: string
  /**
   * The evolved arm's workspace-verifier build command, with `{python}`
   * replaced by the per-task venv python.
   */
  buildCommandTemplate: string
  /**
   * Interpreter for every task's venv. Omit to let each task's manifest
   * `python` (the official per-instance interpreter) decide, falling back to
   * {@link DEFAULT_PYTHON_VERSION}; a value here overrides every task.
   */
  pythonVersion?: string
  envTool: 'uv' | 'venv'
  concurrency: number
  agentTimeoutMs: number
  verifyTimeoutMs: number
  setupTimeoutMs: number
  installTimeoutMs: number
  /**
   * Run each dataset row's `install` command. Defaults to false: the command is
   * dataset-provided shell, so running it is an explicit opt-in. The setup log
   * always records the command and its working directory.
   */
  allowDatasetInstall?: boolean
  taskLimit?: number
  skipExisting: boolean
  keepWork: boolean
  dryRun: boolean
  dshHome?: string
}

/** Summary of one campaign run. */
interface CampaignRunResult {
  planned: number
  armRuns: number
  passed: number
  failed: number
  infraErrors: number
  skipped: number
  resultsPath: string
  statsPath: string
}

/**
 * Execute one campaign (or print its plan in dry-run mode). Arms settle
 * independently and persist to `resultsPath` after each completion, so a
 * killed run resumes with `--skip-existing`; error-only rows (no boolean) are
 * infra failures that stay retryable and are never silent at scoring time
 * (`validateResults` rejects an incomplete file).
 *
 * @param options - campaign configuration.
 * @returns the run summary.
 */
export async function runCampaign(options: CampaignOptions): Promise<CampaignRunResult> {
  const subsetTasks = await loadTaskManifest(options.subsetPath)
  const planned = planCampaign(subsetTasks, options.armMode)
  const chosen = options.taskLimit === undefined ? planned : planned.slice(0, options.taskLimit)
  const armRunsTotal = chosen.reduce((sum, entry) => sum + entry.arms.length, 0)

  if (options.dryRun) {
    console.log(`self-evolve-eval campaign (dry run): ${chosen.length} task(s), ${armRunsTotal} arm run(s)`)
    console.log(`  workdir: ${options.workDir}`)
    console.log(`  dsh entry: ${options.dshEntry} (profile: ${options.profile})`)
    console.log(`  baseline: node --import ${options.tsxImport} ${options.dshEntry} --profile ${options.profile} "<problem_statement>"`)
    console.log(`  evolved:  above + --patch <taskDir>/evolved-overlay.yml (build: ${options.buildCommandTemplate})`)
    console.log(`  env tool: ${options.envTool}${options.envTool === 'uv' ? ' (uv must be installed)' : ' (python3 -m venv)'}`)
    console.log(`  dataset install: ${options.allowDatasetInstall === true
      ? 'enabled (each row\'s install command runs in the base checkout)'
      : 'disabled (pass --allow-dataset-install to run each row\'s install command)'}`)
    for (const entry of chosen.slice(0, 5)) {
      console.log(`  - ${entry.taskId} ${entry.repo}@${entry.baseCommit}`)
    }
    return {
      planned: chosen.length, armRuns: armRunsTotal, passed: 0, failed: 0, infraErrors: 0, skipped: 0,
      resultsPath: options.resultsPath, statsPath: options.statsPath,
    }
  }

  const rowIndex = indexSwebenchRows(await readManifestRows(options.manifestPath))
  await mkdir(options.workDir, { recursive: true })
  await mkdir(dirname(options.resultsPath), { recursive: true })
  const results = await loadResults(options.resultsPath)
  let tasks = results.tasks
  let passed = 0
  let failed = 0
  let infraErrors = 0
  let skipped = 0

  // Writes are serialized through one chain and snapshotted at call time, so
  // concurrent workers cannot interleave and regress the file to a stale state.
  let writeChain: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const snapshot = `${JSON.stringify({ ...results, generatedAt: Date.now(), tasks }, null, 2)}\n`
    const write = writeChain.then(() => saveResults(options.resultsPath, snapshot))
    writeChain = write
    return write
  }
  const recordStats = async (entry: string): Promise<void> => {
    await appendFile(options.statsPath, `${entry}\n`, 'utf8')
  }

  await runPool(chosen, options.concurrency, async (entry): Promise<void> => {
    const { taskId, arms } = entry
    const rawRow = rowIndex.get(taskId)
    if (rawRow === undefined) {
      infraErrors += 1
      tasks = foldInfraFailure(tasks, taskId, arms, 'manifest: missing instance row')
      await persist()
      return
    }
    let row: SwebenchRow | null
    try {
      row = normalizeSwebenchRow(rawRow)
    } catch (error) {
      // A malformed test-id field is a per-task data defect: fold it the same
      // way as a missing or incomplete row so one bad row cannot abort a run.
      infraErrors += 1
      const detail = `manifest: ${errorMessage(error)}`
      tasks = foldInfraFailure(tasks, taskId, arms, detail)
      await persist()
      return
    }
    if (row === null) {
      infraErrors += 1
      tasks = foldInfraFailure(tasks, taskId, arms, 'manifest: incomplete row (needs repo/base_commit/problem_statement/test_patch)')
      await persist()
      return
    }

    let workspace: PreparedWorkspace
    try {
      workspace = await prepareTaskWorkspace({
        workDir: options.workDir, task: entryTask(entry, row), row,
        pythonVersion: options.pythonVersion ?? row.python ?? DEFAULT_PYTHON_VERSION,
        envTool: options.envTool, setupTimeoutMs: options.setupTimeoutMs, installTimeoutMs: options.installTimeoutMs,
        allowDatasetInstall: options.allowDatasetInstall === true,
        logPath: join(options.workDir, entry.taskId, 'setup.log'),
      })
    } catch (error) {
      infraErrors += 1
      const detail = `env: ${errorMessage(error)}`
      tasks = foldInfraFailure(tasks, taskId, arms, detail)
      await persist()
      for (const arm of arms) {
        await recordStats(statLine(Date.now(), taskId, arm, 'env', false, 0, null, detail))
      }
      return
    }

    for (const arm of arms) {
      if (options.skipExisting && settledFor(tasks, taskId, arm)) {
        skipped += 1
        continue
      }
      const result = await runArm(workspace, arm, options)
      if (result.kind === 'infra') {
        // No verdict exists for this arm (its ids never executed), so fold an
        // infra failure that a rerun can settle rather than a failed verdict.
        infraErrors += 1
        const detail = `verify: ${result.detail}`
        tasks = mergeArmOutcome(tasks, taskId, arm, undefined, detail)
        await persist()
        await recordStats(statLine(Date.now(), taskId, arm, 'verify', false, result.seconds, null, detail))
        continue
      }
      if (result.passed) passed += 1
      else failed += 1
      tasks = mergeArmOutcome(tasks, taskId, arm, result.passed, result.error)
      await persist()
      await recordStats(
        statLine(Date.now(), taskId, arm, 'verdict', result.passed, result.seconds, result.exitCode ?? null, result.error ?? ''),
      )
    }

    if (!options.keepWork && arms.every(arm => settledFor(tasks, taskId, arm))) {
      await rm(workspace.taskDir, { recursive: true, force: true })
    }
  })

  return {
    planned: chosen.length, armRuns: armRunsTotal, passed, failed, infraErrors, skipped,
    resultsPath: options.resultsPath, statsPath: options.statsPath,
  }
}

/** One arm's settled verdict. */
interface ArmVerdict {
  kind: 'verdict'
  passed: boolean
  /** Why the arm failed; absent when it passed. */
  error?: string
  seconds: number
  exitCode?: number
}

/** An arm that produced no verdict at all, so it stays retryable. */
interface ArmInfra {
  kind: 'infra'
  /** What prevented a verdict. */
  detail: string
  seconds: number
}

/** One arm run's outcome: a settled verdict or an infra failure to retry. */
type ArmOutcome = ArmVerdict | ArmInfra

/**
 * Agent run → prediction → verdict for one arm. A dsh process crash (non-zero
 * exit) is retried once — infra, not evidence; an agent timeout and a verdict
 * failure are final.
 */
async function runArm(
  workspace: PreparedWorkspace,
  arm: CampaignArm,
  options: CampaignOptions,
): Promise<ArmOutcome> {
  const taskId = workspace.taskId
  const taskDir = join(options.workDir, taskId)
  const logDir = join(taskDir, 'logs')
  await mkdir(logDir, { recursive: true })
  let overlayPath: string | undefined
  if (arm === 'evolved') {
    overlayPath = join(taskDir, 'evolved-overlay.yml')
    const buildCommand = options.buildCommandTemplate.replaceAll('{python}', workspace.venvPython)
    await writeFile(overlayPath, renderEvolvedOverlay({ buildCommand }))
  }
  const agentLog = join(logDir, `${arm}-agent.log`)
  const started = Date.now()
  const agentOptions = {
    workspace, arm, taskText: workspace.row.problemStatement, profile: options.profile,
    dshEntry: options.dshEntry, tsxImport: options.tsxImport, tsconfigPath: options.tsconfigPath,
    timeoutMs: options.agentTimeoutMs, logPath: agentLog,
    ...(overlayPath === undefined ? {} : { overlayPath }),
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
  }
  const first = await runAgent(agentOptions)
  let agentRun = first
  if (first.exitCode !== 0 && !first.timeout) {
    agentRun = await runAgent(agentOptions)
  }
  const seconds = (Date.now() - started) / 1000
  if (agentRun.spawnError !== null) {
    return { kind: 'verdict', passed: false, error: `agent spawn failed: ${agentRun.spawnError}`, seconds, exitCode: agentRun.exitCode }
  }
  if (agentRun.exitCode !== 0) {
    const extra = agentRun.timeout ? ' (agent timeout)' : ''
    const retried = agentRun !== first ? ' after retry' : ''
    return {
      kind: 'verdict', passed: false, error: `agent exited ${agentRun.exitCode}${extra}${retried}`,
      seconds, exitCode: agentRun.exitCode,
    }
  }
  const predictionPath = join(taskDir, `prediction-${arm}.patch`)
  let prediction: string | null
  try {
    prediction = await collectPrediction(workspace, arm, predictionPath)
  } catch (error) {
    return { kind: 'verdict', passed: false, error: `prediction collection failed: ${errorMessage(error)}`, seconds }
  }
  if (prediction === null) {
    return { kind: 'verdict', passed: false, error: 'no prediction (empty diff)', seconds, exitCode: 0 }
  }
  try {
    const verdict = await verifyVerdict(
      workspace, arm, prediction, options.verifyTimeoutMs, join(logDir, `${arm}-verify.log`),
    )
    if (verdict.infra === true) return { kind: 'infra', detail: verdict.detail, seconds }
    return verdict.passed
      ? { kind: 'verdict', passed: true, seconds, exitCode: 0 }
      : { kind: 'verdict', passed: false, error: verdict.detail, seconds, exitCode: 0 }
  } catch (error) {
    return { kind: 'verdict', passed: false, error: `verdict failed: ${errorMessage(error)}`, seconds }
  }
}

/** Recover the EvalTask view of a plan entry (subset fields + raw row verdict fields). */
function entryTask(entry: CampaignPlanEntry, row: SwebenchRow): EvalTask {
  return {
    instanceId: entry.taskId,
    repo: entry.repo,
    baseCommit: entry.baseCommit,
    failToPass: row.failToPass,
    passToPass: row.passToPass,
  }
}

/** Mark every requested arm with an infra failure (retryable error row). */
function foldInfraFailure(
  tasks: PartialTaskOutcome[],
  taskId: string,
  arms: readonly CampaignArm[],
  detail: string,
): PartialTaskOutcome[] {
  let updated = tasks
  for (const arm of arms) updated = mergeArmOutcome(updated, taskId, arm, undefined, detail)
  return updated
}

/** Whether the arm already has a settled boolean verdict. */
function settledFor(tasks: readonly PartialTaskOutcome[], taskId: string, arm: CampaignArm): boolean {
  const row = tasks.find(candidate => candidate.taskId === taskId)
  if (row === undefined) return false
  return arm === 'baseline' ? row.baselinePassed !== undefined : row.evolvedPassed !== undefined
}

/** The raw results file shape on disk (arms may be open mid-campaign). */
interface RawResultsFile {
  seed?: number
  subsetSize?: number
  generatedAt?: number
  tasks: PartialTaskOutcome[]
}

async function loadResults(path: string): Promise<RawResultsFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { tasks: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`results file ${path} is not valid JSON; move it aside or delete it to start a fresh campaign`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`results file ${path} is not a JSON object; move it aside or delete it to start a fresh campaign`)
  }
  const record = parsed as Record<string, unknown>
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.filter(isPartialTaskOutcome)
    : []
  return {
    ...(typeof record.seed === 'number' ? { seed: record.seed } : {}),
    ...(typeof record.subsetSize === 'number' ? { subsetSize: record.subsetSize } : {}),
    ...(typeof record.generatedAt === 'number' ? { generatedAt: record.generatedAt } : {}),
    tasks,
  }
}

function isPartialTaskOutcome(value: unknown): value is PartialTaskOutcome {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).taskId === 'string'
}

async function saveResults(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, path)
}

/** One campaign-stats JSONL line. */
function statLine(
  ts: number,
  taskId: string,
  arm: CampaignArm,
  stage: string,
  ok: boolean,
  seconds: number,
  exitCode: number | null,
  detail: string,
): string {
  return JSON.stringify({
    ts, taskId, arm, stage, ok, seconds: Math.round(seconds), ...(exitCode === null ? {} : { exitCode }), detail,
  })
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      /* v8 ignore next -- noUncheckedIndexedAccess: next is always < items.length in the loop body, so the item is defined. */
      if (item === undefined) continue
      await worker(item)
    }
  })
  await Promise.all(workers)
}
