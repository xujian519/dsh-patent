/**
 * Operator driver for the benchmark provider: mount this row beside a
 * `selfEvolveBenchmark` provider to run one baseline measurement from a
 * profile, without an interactive session.
 *
 * The benchmark service is programmatic only — no model-facing tool starts an
 * establish or optimize loop — so a deployment that wants a baseline needs a
 * host that creates a parent Agent for the fork seams and calls the service
 * once. This module is that host: it creates one Agent, runs
 * {@link BenchmarkEvolveEngine.establishBaseline}, prints the resulting
 * scoreboard entry as JSON on stdout, and requests process exit.
 *
 * @module @deepseek-ai/dsh-self-evolve-benchmark/baseline-driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection, type AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BenchmarkId } from './brand.ts'
import type {} from './index.ts'

/** Stable Cordis plugin name. */
export const name = 'self-evolve-benchmark-baseline-driver'

/** Services required before one baseline run can start. */
export const inject = ['agents', 'agentDefaultModel', 'selfEvolveBenchmark']

/** Plugin config: which benchmark to measure and how many runs each case gets. */
export interface Config {
  /** Benchmark id whose seeded store lives under the provider's `baseDir`. */
  benchmarkId: string
  /** Runs per case; defaults to 1 when omitted. */
  runsPerCase: number
}

export const Config: z<Config> = z.object({
  benchmarkId: z.string().required(),
  runsPerCase: z.natural().min(1).default(1),
})

/** Process-facing effects of one driver run. */
interface DriverIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the agent disposes. */
  exit(code: number): void
}

/**
 * Create one parent Agent, run the baseline, and report the entry.
 *
 * The parent Agent never receives a task: the fork seams only need a live
 * parent for model selection and tool inheritance, and an idle parent keeps
 * the child sessions as the only model traffic.
 *
 * @param ctx - plugin context carrying the Agent registry and benchmark service.
 * @param config - benchmark id and runs per case.
 * @param io - stdout, stderr, and the launcher's bounded exit request.
 */
async function run(ctx: Context, config: Config, io: DriverIo): Promise<void> {
  // Loader siblings mount concurrently; wait for the complete application so
  // the fork seams see every tool and adapter of this profile.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const engine = ctx.get('selfEvolveBenchmark')
  if (agents === undefined || defaultModel === undefined || engine === undefined) {
    throw new Error('baseline driver requires the agents, agentDefaultModel, and selfEvolveBenchmark services')
  }

  const selection = defaultModel.currentSelection()
  const agentOptions: AgentOptions = { ...selection }
  const fs = ctx.get('fs')
  const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions,
    setup: (agentCtx) => { installModelSelection(agentCtx) },
  })
  try {
    await handle.agent.whenIdle()
    const entry = await engine.establishBaseline(BenchmarkId(config.benchmarkId), {
      runsPerCase: config.runsPerCase,
      sessionId,
      provider: selection.provider,
      modelId: selection.model,
      signal: new AbortController().signal,
    })
    io.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
  } finally {
    await handle.dispose()
  }
  io.exit(0)
}

/**
 * Mount the one-shot baseline driver.
 * @param ctx - plugin context carrying the core services and the launcher exit request.
 * @param config - validated benchmark id and runs per case.
 */
export function apply(ctx: Context, config: Config): void {
  // `appExit` is a launcher-provided host value, never an injected dependency.
  const exit = ctx.get('appExit')
  const io: DriverIo = { stdout: process.stdout, stderr: process.stderr, exit: code => exit?.(code) }
  void run(ctx, config, io).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`dsh: self-evolve benchmark baseline failed: ${message}\n`)
    io.exit(1)
  })
}
