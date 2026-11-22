/** Cancelling a `gh` child whose process group already exited must not surface as a failure. */
import { describe, expect, it, vi } from 'vitest'
import { ghRunner } from '../src/gh.ts'

vi.mock('execa', () => ({
  execa: (_command: string, _args: readonly string[], options: { cancelSignal: AbortSignal }) => Object.assign(
    new Promise((resolve) => {
      options.cancelSignal.addEventListener('abort', () => {
        resolve({ exitCode: 137, isCanceled: true, isMaxBuffer: false, stdout: '', stderr: '' })
      }, { once: true })
    }),
    { pid: 4242 },
  ),
}))

describe('gh runner cancellation of an exited process group', () => {
  it('swallows the kill rejection and reports the caller cancellation', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('kill ESRCH: no such process')
    })
    const run = ghRunner({ ghCommand: 'gh', timeoutMs: 5_000, maxOutputBytes: 1_000 })
    const controller = new AbortController()
    const result = run(['api', 'user'], controller.signal)

    controller.abort(new Error('cancelled after the group exited'))

    await expect(result).rejects.toThrow('cancelled after the group exited')
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
  })
})
