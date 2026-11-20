// Real-service test: mounts the patent-data plugin on a real Context (over the
// real subprocess provider) and drives the search provider/cache with an
// injected search function; only the external search seam is mocked.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PatentData, {
  CniprChannel,
  cachedSearchPatents,
  DEFAULT_CNIPR_PAGE_BUDGETS,
  DEFAULT_EGO_COMMAND_NAME,
  DEFAULT_EGO_MAX_OUTPUT_BYTES,
  DEFAULT_EGO_MAX_TIMEOUT_MS,
  DEFAULT_EGO_PROBE_TIMEOUT_MS,
  DEFAULT_EGO_TIMEOUT_MS,
  EgoBrowserSession,
} from '@deepseek-ai/dsh-patent-data'
import type { EgoSpawnRunner, EgoSpawnSpec } from '@deepseek-ai/dsh-patent-data'
import type { PatentSearchResult } from '@deepseek-ai/nuo-patent'

/** A capture-only spawn runner: records each spec and answers with a fixed result. */
function recordingRunner(specs: EgoSpawnSpec[]): EgoSpawnRunner {
  return {
    spawn: async (spec) => {
      specs.push(spec)
      // The probe marker plus padding, so one runner serves both the probe and a
      // run whose merged output exceeds a small configured cap.
      return { exitCode: 0, stdout: `EGO_DOCTOR_OK\n${'y'.repeat(64)}`, stderr: '', timedOut: false, durationMs: 1 }
    },
  }
}

/** A runner that answers the probe and returns an empty CNIPR receipt for script runs. */
function receiptRunner(specs: EgoSpawnSpec[]): EgoSpawnRunner {
  return {
    spawn: async (spec) => {
      specs.push(spec)
      const stdout = spec.stdinData === undefined ? 'EGO_DOCTOR_OK' : 'EGO_CNIPR_PDFLINKS:{"items":[]}'
      return { exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1 }
    },
  }
}

function makeSearchResult(): PatentSearchResult {
  return {
    query: 'thermal',
    total: 1,
    hits: [
      {
        patent: 'US11452699B2',
        title: 'Thermal management system',
        assignee: 'Apple Inc.',
        publication_date: '2022-09-27',
        priority_date: '2019-12-31',
        abstract: 'A thermal management system.',
        url: 'https://patents.google.com/patent/US11452699B2',
      },
    ],
    warnings: [],
  }
}

describe('PatentData service', () => {
  it('serves a search provider that caches repeated queries', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData)
    try {
      expect(ctx.patentData).toBeInstanceOf(PatentData)

      const underlying = vi.fn(async () => makeSearchResult())
      const provider = ctx.patentData.createSearchProvider({ search: cachedSearchPatents(underlying) })
      const first = await provider.search!('thermal')
      const second = await provider.search!('thermal')

      expect(underlying).toHaveBeenCalledTimes(1)
      expect(first).toEqual(second)
      expect(first[0]).toEqual({
        title: 'Thermal management system',
        snippet: 'A thermal management system.',
        url: 'https://patents.google.com/patent/US11452699B2',
        publicationDate: '2022-09-27',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('builds an ego-browser session over the injected subprocess service', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData)
    try {
      const session = ctx.patentData.createEgoSession({ platform: 'darwin' })
      expect(session).toBeInstanceOf(EgoBrowserSession)
      expect(session.taskSpaceName('patent-download', 'abc')).toBe('sati-patent-download-abc')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes ctx.patentData when its fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = ctx.plugin(PatentData)
    await fiber
    expect(ctx.patentData).toBeInstanceOf(PatentData)
    await fiber.dispose()
    expect(ctx.get('patentData')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('defaults every Config field to the shipped seam default', () => {
    expect(PatentData.Config({})).toEqual({
      commandName: DEFAULT_EGO_COMMAND_NAME,
      probeTimeoutMs: DEFAULT_EGO_PROBE_TIMEOUT_MS,
      defaultTimeoutMs: DEFAULT_EGO_TIMEOUT_MS,
      maxTimeoutMs: DEFAULT_EGO_MAX_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_EGO_MAX_OUTPUT_BYTES,
      nuoRequestChannel: 'auto',
      cniprEnabled: false,
      cniprLoginPollMs: DEFAULT_CNIPR_PAGE_BUDGETS.loginPollMs,
      cniprLoginAttempts: DEFAULT_CNIPR_PAGE_BUDGETS.loginAttempts,
      cniprLoginRounds: DEFAULT_CNIPR_PAGE_BUDGETS.loginRounds,
      cniprNavigationTimeoutMs: DEFAULT_CNIPR_PAGE_BUDGETS.navigationTimeoutMs,
      cniprActionTimeoutMs: DEFAULT_CNIPR_PAGE_BUDGETS.actionTimeoutMs,
      cniprResultTimeoutMs: DEFAULT_CNIPR_PAGE_BUDGETS.resultTimeoutMs,
      cniprRenderTimeoutMs: DEFAULT_CNIPR_PAGE_BUDGETS.renderTimeoutMs,
      cniprDetailTimeoutMs: DEFAULT_CNIPR_PAGE_BUDGETS.detailTimeoutMs,
    })
  })

  it('fails loud on an inverted timeout configuration instead of clamping every run', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      expect(() => new PatentData(ctx, { ...PatentData.Config({}), defaultTimeoutMs: 90_000, maxTimeoutMs: 1_000 }))
        .toThrow(/defaultTimeoutMs .* must not exceed maxTimeoutMs/)
      expect(() => new PatentData(ctx, { ...PatentData.Config({}), maxOutputBytes: 0 }))
        .toThrow(/maxOutputBytes must be a positive integer/)
      expect(() => new PatentData(ctx, { ...PatentData.Config({}), commandName: '' }))
        .toThrow(/commandName must not be empty/)
      expect(() => new PatentData(ctx, { ...PatentData.Config({}), cniprLoginRounds: 0 }))
        .toThrow(/cniprLoginRounds must be a positive integer/)
      expect(() => new PatentData(ctx, { ...PatentData.Config({}), cniprDetailTimeoutMs: 1.5 }))
        .toThrow(/cniprDetailTimeoutMs must be a positive integer/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('builds a CNIPR channel where the deployment enabled it', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData, { cniprEnabled: true })
    try {
      const channel = ctx.patentData.createCniprChannel({ cwd: '/tmp', timeoutMs: 60_000 })
      expect(channel).toBeInstanceOf(CniprChannel)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries configured CNIPR page budgets into the generated script', async () => {
    // 可用性检查看文件系统：在临时主目录放一个可执行的 ego-browser。
    const root = await mkdtemp(join(tmpdir(), 'dsh-patent-data-budgets-'))
    await mkdir(join(root, '.local', 'bin'), { recursive: true })
    const cli = join(root, '.local', 'bin', 'ego-browser')
    await writeFile(cli, '')
    await chmod(cli, 0o755)

    const specs: EgoSpawnSpec[] = []
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData, {
      cniprEnabled: true,
      cniprLoginPollMs: 250,
      cniprLoginAttempts: 3,
      cniprLoginRounds: 1,
      cniprNavigationTimeoutMs: 12_000,
      cniprActionTimeoutMs: 4_000,
      cniprResultTimeoutMs: 5_000,
      cniprRenderTimeoutMs: 6_000,
      cniprDetailTimeoutMs: 7_000,
    })
    try {
      const service = ctx.patentData
      const createSession = service.createEgoSession.bind(service)
      vi.spyOn(service, 'createEgoSession').mockImplementation(() =>
        createSession({ runner: receiptRunner(specs), homeDir: root, platform: 'darwin' }))

      // 逐字段覆盖：只换渲染预算，其余沿用 Config。
      const channel = service.createCniprChannel({ pageBudgets: { renderTimeoutMs: 9_111 } })
      expect(channel).toBeInstanceOf(CniprChannel)
      await channel?.pdfLinks(['CN122072823A'])

      const script = specs.at(-1)?.stdinData ?? ''
      expect(script).toContain('const LOGIN_POLL_MS = 250')
      expect(script).toContain('const LOGIN_ATTEMPTS = 3')
      expect(script).toContain('const LOGIN_ROUNDS = 1')
      expect(script).toContain('const NAVIGATION_TIMEOUT_MS = 12000')
      expect(script).toContain('const ACTION_TIMEOUT_MS = 4000')
      expect(script).toContain('const RESULT_TIMEOUT_MS = 5000')
      expect(script).toContain('const RENDER_TIMEOUT_MS = 9111')
      expect(script).toContain('const DETAIL_TIMEOUT_MS = 7000')
    } finally {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns no CNIPR channel while the deployment leaves it disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData)
    try {
      // undefined 是「本部署没有打开这条通道」：消费方据此按号回退，而不是拿到一个必然失败的对象。
      expect(ctx.patentData.createCniprChannel()).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('builds sessions over the configured command, deadlines, and output cap', async () => {
    const specs: EgoSpawnSpec[] = []
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData, {
      commandName: 'ego-lite',
      probeTimeoutMs: 1_234,
      defaultTimeoutMs: 4_321,
      maxTimeoutMs: 5_000,
      maxOutputBytes: 8,
    })
    try {
      const session = ctx.patentData.createEgoSession({ runner: recordingRunner(specs), homeDir: '/tmp' })
      expect(await session.runConnectionProbe()).toBe(true)
      const run = await session.runScript('cliLog("x")', { cwd: '/tmp' })
      // A per-run timeout above the configured cap is clamped to it.
      await session.runScript('cliLog("x")', { cwd: '/tmp', timeoutMs: 999_999 })

      expect(specs.map(spec => spec.argv[0])).toEqual(['ego-lite', 'ego-lite', 'ego-lite'])
      expect(specs.map(spec => spec.timeoutMs)).toEqual([1_234, 4_321, 5_000])
      expect(run.output).toContain('[output truncated]')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a per-call option override the configured default', async () => {
    const specs: EgoSpawnSpec[] = []
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PatentData, { commandName: 'ego-lite' })
    try {
      const session = ctx.patentData.createEgoSession({ runner: recordingRunner(specs), commandName: 'ego-per-call', homeDir: '/tmp' })
      expect(await session.runConnectionProbe()).toBe(true)
      expect(specs[0]?.argv[0]).toBe('ego-per-call')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the seam defaults when the service is constructed without a Config', async () => {
    const specs: EgoSpawnSpec[] = []
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      const session = new PatentData(ctx).createEgoSession({ runner: recordingRunner(specs), homeDir: '/tmp' })
      expect(await session.runConnectionProbe()).toBe(true)
      await session.runScript('cliLog("x")', { cwd: '/tmp' })
      expect(specs.map(spec => spec.argv[0])).toEqual([DEFAULT_EGO_COMMAND_NAME, DEFAULT_EGO_COMMAND_NAME])
      expect(specs.map(spec => spec.timeoutMs)).toEqual([DEFAULT_EGO_PROBE_TIMEOUT_MS, DEFAULT_EGO_TIMEOUT_MS])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
