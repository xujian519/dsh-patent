/**
 * CLI entry of the P1-10 evaluation scaffold.
 *
 *   pnpm eval:self-evolve subset  --manifest m.jsonl --seed 20260821 --count 60 --out subset.json
 *   pnpm eval:self-evolve score   --results results.json
 *   pnpm eval:self-evolve decide  --results results.json --write
 *
 * `score` prints the paired summary and bootstrap confidence interval;
 * `decide --write` persists the continue/rollback record that arms the
 * `verify-self-evolve-eval` gate. Running from the repository root is
 * required (default artifact paths are repo-relative).
 *
 * @module @deepseek-ai/dsh-self-evolve-eval/cli
 */

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { runCampaign } from './campaign/orchestrate.ts'
import { resolveSourceLaunchAnchors } from './campaign/source-launch.ts'
import { DEFAULT_ALPHA, DEFAULT_MIN_EFFECT, decide, recordDecision } from './decision.ts'
import { bootstrapCi, summarize, validateResults } from './score.ts'
import { DEFAULT_SUBSET_SIZE, loadTaskManifest, selectSubsetWithReserve } from './subset.ts'
import type { EvalResults } from './types.ts'

/** Default artifact directory, relative to the repository root. */
const DEFAULT_EVAL_DIR = join('packages', 'self-evolve', 'evaluation')
/** Default decision record file inside the artifact directory. */
const DEFAULT_DECISION_PATH = join(DEFAULT_EVAL_DIR, 'eval-decision.json')

function usage(): void {
  console.log('self-evolve-eval: P1-10 evaluation scaffold')
  console.log('  subset  --manifest <json|jsonl> --seed <n> [--count 60] [--reserve <n> --reserve-out <path>] --out <subset.json>')
  console.log('  score   --results <results.json> [--seed <n>]')
  console.log('  decide  --results <results.json> [--seed <n>] [--subset <subset.json>] [--alpha <p>] [--min-effect <d>] [--prior-reuses <n>] [--write] [--out <path>]')
  console.log('  campaign --manifest <jsonl> --subset <subset.json> --results <results.json> --stats <stats.jsonl> \\')
  console.log('           --work-dir <dir> [--arm both|baseline|evolved] [--profile headless] [--env-tool uv|venv] \\')
  console.log('           [--dsh-entry <bin.ts>] [--tsx-import <absolute hook path>] [--build-command <template>] [--python <v>] \\')
  console.log('           [--concurrency <n>] [--agent-timeout <ms>] [--verify-timeout <ms>] \\')
  console.log('           [--setup-timeout <ms>] [--install-timeout <ms>] [--allow-dataset-install] [--task-limit <n>] \\')
  console.log('           [--skip-existing] [--keep-work] [--dry-run]')
}

/** Extract one `--key value` argument; null when absent. */
function arg(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) return null
  const raw = process.argv[index + 1]
  if (raw === undefined) return null
  return raw.startsWith('--') ? null : raw
}

function has(name: string): boolean {
  return process.argv.includes(name)
}

function requireArg(name: string): string {
  const value = arg(name)
  if (value === null) {
    console.error(`self-evolve-eval: missing ${name} argument`)
    usage()
    process.exit(2)
  }
  return value
}

async function main(): Promise<void> {
  const command = process.argv[2]
  switch (command) {
    case 'subset': {
      const manifest = requireArg('--manifest')
      const seed = Number(requireArg('--seed'))
      const count = Number(arg('--count') ?? String(DEFAULT_SUBSET_SIZE))
      const reserveCount = Number(arg('--reserve') ?? '0')
      const out = requireArg('--out')
      if (!Number.isInteger(seed) || seed < 0) throw new Error('self-evolve-eval: --seed must be a non-negative integer')
      if (!Number.isInteger(count) || count < 1) throw new Error('self-evolve-eval: --count must be a positive integer')
      if (!Number.isInteger(reserveCount) || reserveCount < 0) throw new Error('self-evolve-eval: --reserve must be a non-negative integer')
      const tasks = await loadTaskManifest(resolve(manifest))
      const { subset, reserve } = selectSubsetWithReserve(tasks, seed, count, reserveCount)
      const subsetJson = `${JSON.stringify(subset, null, 2)}\n`
      await writeJson(resolve(out), subset)
      console.log(`self-evolve-eval: selected ${subset.length} task(s) from ${tasks.length} with seed ${seed} → ${out}`)
      // The digest identifies the exact subset bytes a decision was taken on, so
      // repeated decisions against it can declare their reuse count.
      console.log(`self-evolve-eval: subsetDigest=${sha256(subsetJson)}`)
      if (reserveCount > 0) {
        if (reserve.length < reserveCount) {
          throw new Error(`self-evolve-eval: --reserve ${reserveCount} requested but only ${reserve.length} task(s) remain after the subset`)
        }
        const reserveOut = arg('--reserve-out')
        if (reserveOut === null) throw new Error('self-evolve-eval: --reserve requires --reserve-out')
        await writeJson(resolve(reserveOut), reserve)
        console.log(`self-evolve-eval: reserved ${reserve.length} unseen task(s) → ${reserveOut}`)
      }
      return
    }
    case 'score': {
      const results = validateResults(JSON.parse(await readFile(resolve(requireArg('--results')), 'utf8')))
      const ci = bootstrapCi(results, { seed: Number(arg('--seed') ?? 0) })
      printScore(results, ci.low, ci.high, ci.resamples)
      return
    }
    case 'decide': {
      const results = validateResults(JSON.parse(await readFile(resolve(requireArg('--results')), 'utf8')))
      const subsetArg = arg('--subset')
      const subsetDigest = subsetArg === null
        ? undefined
        : sha256(await readFile(resolve(subsetArg), 'utf8'))
      const decision = decide(results, {
        seed: Number(arg('--seed') ?? 0),
        alpha: Number(arg('--alpha') ?? String(DEFAULT_ALPHA)),
        minEffect: Number(arg('--min-effect') ?? String(DEFAULT_MIN_EFFECT)),
        priorReuses: Number(arg('--prior-reuses') ?? '0'),
        ...(subsetDigest === undefined ? {} : { subsetDigest }),
      })
      printScore(results, decision.ci.low, decision.ci.high, decision.ci.resamples)
      console.log(`self-evolve-eval: mcnemar p=${decision.mcnemar.pValue.toExponential(3)} over ${decision.mcnemar.discordant} discordant pair(s)`)
      console.log(`self-evolve-eval: alpha=${decision.alpha} minEffect=${decision.minEffect} priorReuses=${decision.priorReuses}`)
      console.log(`self-evolve-eval: crossesZero=${decision.crossesZero} recommended=${decision.recommended}`)
      if (has('--write')) {
        const out = resolve(arg('--out') ?? DEFAULT_DECISION_PATH)
        await recordDecision(out, decision)
        console.log(`self-evolve-eval: recorded decision → ${out}`)
      }
      return
    }
    case 'campaign': {
      const armMode = arg('--arm') ?? 'both'
      if (armMode !== 'baseline' && armMode !== 'evolved' && armMode !== 'both') {
        throw new Error('self-evolve-eval: --arm must be baseline, evolved, or both')
      }
      const envTool = arg('--env-tool') ?? 'uv'
      if (envTool !== 'uv' && envTool !== 'venv') {
        throw new Error('self-evolve-eval: --env-tool must be uv or venv')
      }
      const manifest = requireArg('--manifest')
      const subset = requireArg('--subset')
      const results = requireArg('--results')
      const stats = requireArg('--stats')
      const workDir = requireArg('--work-dir')
      const profile = arg('--profile') ?? 'headless'
      const dshEntry = resolve(arg('--dsh-entry') ?? 'apps/cli/src/bin.ts')
      const tsxOverride = arg('--tsx-import')
      const anchors = resolveSourceLaunchAnchors(dshEntry, tsxOverride === null ? {} : { tsxImport: tsxOverride })
      const tsxImport = tsxOverride ?? anchors.tsxImport
      const buildCommandTemplate = arg('--build-command') ?? '{python} -m compileall -q .'
      // Absent leaves the per-task `python` (an augmented manifest's official
      // interpreter) in charge; an explicit flag overrides every task.
      const pythonVersion = arg('--python') ?? undefined
      const concurrency = Number(arg('--concurrency') ?? '1')
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('self-evolve-eval: --concurrency must be a positive integer')
      }
      const agentTimeoutMs = Number(arg('--agent-timeout') ?? '1800000')
      const verifyTimeoutMs = Number(arg('--verify-timeout') ?? '1800000')
      const setupTimeoutMs = Number(arg('--setup-timeout') ?? '300000')
      const installTimeoutMs = Number(arg('--install-timeout') ?? '600000')
      const taskLimitRaw = arg('--task-limit')
      const taskLimit = taskLimitRaw === null ? undefined : Number(taskLimitRaw)
      if (taskLimit !== undefined && (!Number.isInteger(taskLimit) || taskLimit < 1)) {
        throw new Error('self-evolve-eval: --task-limit must be a positive integer')
      }
      const summary = await runCampaign({
        manifestPath: resolve(manifest),
        subsetPath: resolve(subset),
        resultsPath: resolve(results),
        statsPath: resolve(stats),
        workDir: resolve(workDir),
        armMode,
        profile,
        dshEntry,
        tsxImport,
        tsconfigPath: anchors.tsconfigPath,
        buildCommandTemplate,
        ...(pythonVersion === undefined ? {} : { pythonVersion }),
        envTool,
        concurrency,
        agentTimeoutMs,
        verifyTimeoutMs,
        setupTimeoutMs,
        installTimeoutMs,
        allowDatasetInstall: has('--allow-dataset-install'),
        ...(taskLimit === undefined ? {} : { taskLimit }),
        skipExisting: has('--skip-existing'),
        keepWork: has('--keep-work'),
        dryRun: has('--dry-run'),
      })
      console.log(`self-evolve-eval: campaign done planned=${summary.planned} armRuns=${summary.armRuns} passed=${summary.passed} failed=${summary.failed} infraErrors=${summary.infraErrors} skipped=${summary.skipped}`)
      return
    }
    default:
      usage()
      process.exit(2)
  }
}

function printScore(results: EvalResults, low: number, high: number, resamples: number): void {
  const summary = summarize(results)
  console.log('self-evolve-eval:')
  console.log(`  tasks=${summary.n} wins=${summary.wins} losses=${summary.losses} netWin=${summary.netWin}`)
  console.log(`  baselineRate=${summary.baselineRate} evolvedRate=${summary.evolvedRate} winRateDelta=${summary.winRateDelta}`)
  console.log(`  ci95=[${low.toFixed(4)}, ${high.toFixed(4)}] (${resamples} resamples)`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Lowercase SHA-256 of a string; identifies the exact subset bytes a decision covered. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function entry(): Promise<void> {
  try {
    await main()
  } catch (error: unknown) {
    console.error(`self-evolve-eval: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// Run the CLI only when executed directly; importing the module stays side-effect free.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  void entry()
}
