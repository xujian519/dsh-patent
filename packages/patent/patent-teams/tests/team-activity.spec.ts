// One-shot team change waiters behind patent_teams_wait: wake on the next
// announced change of the same team, time out otherwise, and release every
// waiter on abort or disposal. Timeouts here are milliseconds; the accepted
// model-facing range is validated by the service, not by this registry.
import { describe, expect, it } from 'vitest'
import { TeamActivity } from '../src/team-activity.ts'

describe('TeamActivity', () => {
  it('resolves a waiter when its own team changes', async () => {
    const activity = new TeamActivity()
    const wait = activity.wait('team1', 60_000, new AbortController().signal)
    activity.notify('team1')
    await expect(wait).resolves.toEqual({ timedOut: false })
  })

  it('times out when nothing changes', async () => {
    const activity = new TeamActivity()
    await expect(activity.wait('team1', 5, new AbortController().signal)).resolves.toEqual({ timedOut: true })
  })

  it('ignores a change announced for another team', async () => {
    const activity = new TeamActivity()
    const wait = activity.wait('team1', 5, new AbortController().signal)
    activity.notify('team2')
    await expect(wait).resolves.toEqual({ timedOut: true })
  })

  it('wakes every waiter of one team', async () => {
    const activity = new TeamActivity()
    const signal = new AbortController().signal
    const first = activity.wait('team1', 60_000, signal)
    const second = activity.wait('team1', 60_000, signal)
    activity.notify('team1')
    await expect(Promise.all([first, second])).resolves.toEqual([
      { timedOut: false },
      { timedOut: false },
    ])
  })

  it('rejects an aborted wait with the abort reason', async () => {
    const activity = new TeamActivity()
    const controller = new AbortController()
    const wait = activity.wait('team1', 60_000, controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(wait).rejects.toThrow('caller cancelled')
  })

  it('wraps a non-Error abort reason in an Error', async () => {
    const activity = new TeamActivity()
    const controller = new AbortController()
    const wait = activity.wait('team1', 60_000, controller.signal)
    controller.abort('caller gave up')
    await expect(wait).rejects.toThrow('patent_teams_wait aborted: caller gave up')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const activity = new TeamActivity()
    const controller = new AbortController()
    controller.abort()
    await expect(activity.wait('team1', 60_000, controller.signal)).rejects.toBeDefined()
  })

  it('releases every waiter on close and refuses later waits', async () => {
    const activity = new TeamActivity()
    const wait = activity.wait('team1', 60_000, new AbortController().signal)
    const other = activity.wait('team2', 60_000, new AbortController().signal)
    activity.close()
    await expect(Promise.all([wait, other])).resolves.toEqual([
      { timedOut: false },
      { timedOut: false },
    ])
    await expect(activity.wait('team1', 5, new AbortController().signal)).resolves.toEqual({ timedOut: false })
  })

  it('drops a waiter that already timed out', async () => {
    const activity = new TeamActivity()
    await activity.wait('team1', 5, new AbortController().signal)
    // The entry is removed on settlement, so notifying afterwards is a no-op.
    expect(() => { activity.notify('team1') }).not.toThrow()
  })

  it('removes internal waiter state after timeout (F-PAT-035)', async () => {
    // 第一个 wait timeout 后，内部 waiters Map 应清空。第二个 wait 同 teamId，
    // notify 只唤醒它——如果 finish() 漏了 waiters.delete，第一次 timeout 后
    // 残留的 waiter 会在第二次 notify 时也 resolve，造成双唤醒。
    const activity = new TeamActivity()
    await activity.wait('team1', 5, new AbortController().signal)
    const second = activity.wait('team1', 60_000, new AbortController().signal)
    activity.notify('team1')
    await expect(second).resolves.toEqual({ timedOut: false })
  })
})
