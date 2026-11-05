/** Model-visible copy shared by the mirrored persistent bash and pwsh tools. */
import { describe, expect, it } from 'vitest'
import {
  LOST_PREFIX_NOTICE, TRUNCATED_NOTICE, timeoutNotice,
} from '../src/notices.ts'
import {
  LOST_PREFIX_NOTICE as PWSH_LOST_PREFIX_NOTICE,
  TRUNCATED_NOTICE as PWSH_TRUNCATED_NOTICE,
  timeoutNotice as pwshTimeoutNotice,
} from '../../tool-pwsh-persistent/src/notices.ts'

describe('persistent shell notices', () => {
  it('reports the elapsed timeout without claiming memory exhaustion', () => {
    expect(timeoutNotice(10)).toBe('Your command timed out after 0 seconds. Below is partial output:')
    expect(timeoutNotice(300_000)).toBe('Your command timed out after 300 seconds. Below is partial output:')
  })

  it('attributes clipping to command output and terminal scrollback', () => {
    expect(TRUNCATED_NOTICE).toContain('Only part of this command output is shown')
    expect(TRUNCATED_NOTICE).toContain('terminal scrollback')
    expect(TRUNCATED_NOTICE).toContain('Re-run a narrower command')
    expect(TRUNCATED_NOTICE).not.toContain('grep')
    expect(LOST_PREFIX_NOTICE).toContain('terminal scrollback limit')
  })

  it('keeps the pwsh copy identical to the bash copy', () => {
    expect(PWSH_TRUNCATED_NOTICE).toBe(TRUNCATED_NOTICE)
    expect(PWSH_LOST_PREFIX_NOTICE).toBe(LOST_PREFIX_NOTICE)
    expect(pwshTimeoutNotice(2_500)).toBe(timeoutNotice(2_500))
  })
})
