// Port of Sati tests/patent/data/nuo/egoSession.spec.ts: availability checks,
// argv+stdin script runs with PATH injection, output truncation, tagged-JSON
// extraction, task-space naming, the connection probe, and patent normalization.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EgoSpawnResult, EgoSpawnRunner, EgoSpawnSpec } from '@deepseek-ai/dsh-patent-data'
import { EgoBrowserSession, normalizePatentNumber } from '@deepseek-ai/dsh-patent-data'

class FakeRunner implements EgoSpawnRunner {
  calls: EgoSpawnSpec[] = []
  result: Partial<EgoSpawnResult> = {}

  async spawn(spec: EgoSpawnSpec): Promise<EgoSpawnResult> {
    this.calls.push(spec)
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 10, ...this.result }
  }
}

function makeFakeHomeDir(): { homeDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-ego-session-'))
  const bin = join(base, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const cli = join(bin, 'ego-browser')
  writeFileSync(cli, '#!/bin/sh\nexit 0\n')
  chmodSync(cli, 0o755)
  return { homeDir: base }
}

describe('EgoBrowserSession.checkAvailability', () => {
  it('is ok on darwin with the CLI present', () => {
    const { homeDir } = makeFakeHomeDir()
    const session = new EgoBrowserSession({ homeDir, platform: 'darwin' })
    expect(session.checkAvailability()).toEqual({ ok: true })
  })

  it('is unavailable on non-darwin', () => {
    const { homeDir } = makeFakeHomeDir()
    const session = new EgoBrowserSession({ homeDir, platform: 'linux' })
    const result = session.checkAvailability()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unavailable')
  })

  it('is setup_required when the CLI is missing', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-ego-session-missing-'))
    const session = new EgoBrowserSession({ homeDir: base, platform: 'darwin', env: { PATH: '/usr/bin:/bin' } })
    const result = session.checkAvailability()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('setup_required')
      expect(result.reason).toMatch(/lite\.ego\.app/)
    }
  })

  it('defaults the platform to the host process', () => {
    const session = new EgoBrowserSession({ homeDir: '/tmp' })
    expect(session.extractTaggedJson('EGO_PING:{"ok":1}', 'PING')).toEqual({ ok: 1 })
    expect(session.taskSpaceName('probe')).toBe('sati-probe')
  })

  it('is ok for a PATH-less env probe when the CLI sits in ~/.local/bin', () => {
    const { homeDir } = makeFakeHomeDir()
    const session = new EgoBrowserSession({ homeDir, platform: 'darwin' })
    expect(session.checkAvailability({})).toEqual({ ok: true })
  })

  it('is ok on win32 with the CLI present', () => {
    const { homeDir } = makeFakeHomeDir()
    const session = new EgoBrowserSession({ homeDir, platform: 'win32' })
    expect(session.checkAvailability()).toEqual({ ok: true })
  })

  it('is ok on win32 when the CLI is a .cmd in a PATH segment', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-ego-session-cmd-'))
    const bin = join(base, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'ego-browser.cmd'), '@echo off\r\nexit 0\r\n')
    const session = new EgoBrowserSession({ homeDir: base, platform: 'win32', env: { PATH: bin } })
    expect(session.checkAvailability()).toEqual({ ok: true })
  })

  it('is ok when the CLI sits in a configured pathEntries directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-ego-session-entries-'))
    const bin = join(base, 'opt', 'ego', 'bin')
    mkdirSync(bin, { recursive: true })
    const cli = join(bin, 'ego-browser')
    writeFileSync(cli, '#!/bin/sh\nexit 0\n')
    chmodSync(cli, 0o755)
    // pathEntries 会注入 spawn 的 PATH，可用性检查也必须看到同一组目录。
    const session = new EgoBrowserSession({
      homeDir: join(base, 'home'),
      // 空串在构造时被过滤，不会把当前目录当成 PATH 目录。
      pathEntries: ['', bin],
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(session.checkAvailability()).toEqual({ ok: true })
  })
})

describe('EgoBrowserSession.runScript', () => {
  it('runs argv+stdin, injects ~/.local/bin into PATH, and merges stderr', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: '', stderr: 'TITLE: demo\n', timedOut: false, durationMs: 30 }
    const session = new EgoBrowserSession({ runner, homeDir: '/Users/tester', platform: 'darwin' })

    const result = await session.runScript("cliLog('x')", { cwd: '/tmp', timeoutMs: 10_000 })

    expect(runner.calls.length).toBe(1)
    const spec = runner.calls[0]!
    expect(spec.argv).toEqual(['ego-browser', 'nodejs'])
    expect(spec.stdinData).toBe("cliLog('x')")
    expect(spec.env?.PATH).toContain('/Users/tester/.local/bin')
    expect(spec.timeoutMs).toBe(10_000)
    expect(result.output).toBe('TITLE: demo\n')
    expect(result.exitCode).toBe(0)
  })

  it('truncates oversized output', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: 'A'.repeat(1_000), stderr: '', timedOut: false, durationMs: 5 }
    const session = new EgoBrowserSession({ runner, homeDir: '/Users/tester', platform: 'darwin', maxOutputBytes: 100 })

    const result = await session.runScript("cliLog('x')", { cwd: '/tmp' })
    expect(result.output).toContain('[output truncated]')
  })

  it('truncates by bytes without splitting a multibyte character', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: '你好世界', stderr: '', timedOut: false, durationMs: 5 }
    const session = new EgoBrowserSession({ runner, homeDir: '/Users/tester', platform: 'darwin', maxOutputBytes: 7 })

    const result = await session.runScript("cliLog('x')", { cwd: '/tmp' })
    // 前两个汉字占 6 字节，第三个汉字占 3 字节；上限 7 字节只保留完整字符。
    expect(result.output).toBe('你好…\n[output truncated]')
  })

  it('uses the session-level environment for script runs', async () => {
    const runner = new FakeRunner()
    const session = new EgoBrowserSession({
      runner,
      homeDir: '/Users/tester',
      platform: 'darwin',
      env: { PATH: '/session/bin', MARKER: 'session' },
    })

    await session.runScript("cliLog('x')", { cwd: '/tmp' })

    expect(runner.calls[0]?.env?.PATH).toContain('/session/bin')
    expect(runner.calls[0]?.env?.MARKER).toBe('session')
  })

  it('fails loudly when no runner is configured', async () => {
    const session = new EgoBrowserSession({ platform: 'darwin' })
    await expect(session.runScript("cliLog('x')", { cwd: '/tmp' })).rejects.toThrow(/runner not configured/)
  })

  it('forwards a caller signal and a PATH-less env to the spawn', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 5 }
    const session = new EgoBrowserSession({ runner, homeDir: '/Users/tester', platform: 'darwin' })
    const signal = new AbortController().signal

    const result = await session.runScript("cliLog('x')", { cwd: '/tmp', env: {}, signal })

    expect(runner.calls[0]?.signal).toBe(signal)
    expect(runner.calls[0]?.env?.PATH).toBe('/Users/tester/.local/bin')
    expect(result.exitCode).toBe(0)
  })

  it('wraps non-Error spawn failures in a start error that keeps the original cause', async () => {
    const throwingRunner: EgoSpawnRunner = { async spawn() { throw 'ego-browser missing' } }
    const session = new EgoBrowserSession({ runner: throwingRunner, platform: 'darwin' })

    const error = await session.runScript("cliLog('x')", { cwd: '/tmp' }).catch((reason: unknown) => reason)

    if (!(error instanceof Error)) throw error
    expect(error.message).toBe('ego-browser failed to start: ego-browser missing')
    expect(error.cause).toBe('ego-browser missing')
  })

  it('keeps a caller abort instead of wrapping it as a start failure', async () => {
    const controller = new AbortController()
    const abortingRunner: EgoSpawnRunner = {
      async spawn() {
        controller.abort()
        throw new DOMException('This operation was aborted', 'AbortError')
      },
    }
    const session = new EgoBrowserSession({ runner: abortingRunner, platform: 'darwin' })

    await expect(session.runScript("cliLog('x')", { cwd: '/tmp', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('creates nested output directories on demand', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-ego-session-out-'))
    const session = new EgoBrowserSession({ platform: 'darwin' })
    const dir = join(base, 'nested', 'downloads')
    session.ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })

  it('joins PATH with the Windows delimiter', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 5 }
    const session = new EgoBrowserSession({
      runner,
      homeDir: 'C:\\Users\\tester',
      platform: 'win32',
      env: { PATH: 'C:\\Windows' },
    })
    await session.runScript("cliLog('x')", { cwd: 'C:\\work', env: { PATH: 'C:\\Windows' } })
    // Windows joins PATH segments with ';' and appends the home local bin.
    expect(runner.calls[0]?.env?.PATH).toMatch(/^C:\\Windows;/)
    expect(runner.calls[0]?.env?.PATH).toContain('C:\\Users\\tester')
  })
})

describe('EgoBrowserSession.extractTaggedJson', () => {
  it('parses an EGO_<TAG>: payload line', () => {
    const session = new EgoBrowserSession({ platform: 'darwin' })
    const output = 'PROGRESS: 1/2:CN1\nEGO_DOWNLOAD_RESULTS:[{"patent":"CN1","status":"ok"}]\n'
    const parsed = session.extractTaggedJson<Array<{ patent: string; status: string }>>(output, 'DOWNLOAD_RESULTS')
    expect(parsed).toEqual([{ patent: 'CN1', status: 'ok' }])
  })

  it('returns null when the tag is missing or the payload is invalid', () => {
    const session = new EgoBrowserSession({ platform: 'darwin' })
    expect(session.extractTaggedJson('no tag here', 'DOWNLOAD_RESULTS')).toBeNull()
    expect(session.extractTaggedJson('EGO_DOWNLOAD_RESULTS:not-json', 'DOWNLOAD_RESULTS')).toBeNull()
  })
})

describe('EgoBrowserSession.taskSpaceName', () => {
  it('is session-scoped and stable', () => {
    const session = new EgoBrowserSession({ platform: 'darwin' })
    expect(session.taskSpaceName('patent-download', 'abc123')).toBe('sati-patent-download-abc123')
    expect(session.taskSpaceName('patent-download')).toBe('sati-patent-download')
  })
})

describe('EgoBrowserSession.runConnectionProbe', () => {
  it('succeeds when the probe marker is present', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: '', stderr: 'EGO_DOCTOR_OK\n', timedOut: false, durationMs: 200 }
    const session = new EgoBrowserSession({ runner, platform: 'darwin' })

    expect(await session.runConnectionProbe(5_000)).toBe(true)
    expect(runner.calls[0]?.argv).toEqual(['ego-browser', 'nodejs', '-e', "cliLog('EGO_DOCTOR_OK')"])
  })

  it('fails on a non-zero exit or timeout', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 100 }
    const session = new EgoBrowserSession({ runner, platform: 'darwin' })
    expect(await session.runConnectionProbe(5_000)).toBe(false)

    const timeoutRunner = new FakeRunner()
    timeoutRunner.result = { exitCode: null, stdout: '', stderr: '', timedOut: true, durationMs: 8_000 }
    const timeoutSession = new EgoBrowserSession({ runner: timeoutRunner, platform: 'darwin' })
    expect(await timeoutSession.runConnectionProbe(5_000)).toBe(false)
  })

  it('uses the default probe timeout when none is passed', async () => {
    const runner = new FakeRunner()
    runner.result = { exitCode: 0, stdout: 'EGO_DOCTOR_OK\n', stderr: '', timedOut: false, durationMs: 10 }
    const session = new EgoBrowserSession({ runner, platform: 'darwin' })
    expect(await session.runConnectionProbe()).toBe(true)
    expect(runner.calls[0]?.timeoutMs).toBe(8_000)
  })

  it('returns false when the probe spawn fails', async () => {
    const throwingRunner: EgoSpawnRunner = { async spawn() { throw new Error('spawn failed') } }
    const session = new EgoBrowserSession({ runner: throwingRunner, platform: 'darwin' })
    expect(await session.runConnectionProbe()).toBe(false)
  })
})

describe('normalizePatentNumber', () => {
  it('strips separators and upper-cases', () => {
    expect(normalizePatentNumber(' cn115690481a ')).toBe('CN115690481A')
    expect(normalizePatentNumber('US-11739244-B2')).toBe('US11739244B2')
    expect(normalizePatentNumber('ep 1234567 a1')).toBe('EP1234567A1')
  })
})
