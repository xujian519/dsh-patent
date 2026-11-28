// PatSnap live probe: drives the real P020 gateway and spends one credit per
// returned record. Opt-in through DSH_PATSNAP_LIVE=1 plus PATSNAP_API_KEY.
import { describe, expect, it } from 'vitest'
import { PatsnapChannel } from '@deepseek-ai/dsh-patent-data'

/** Opt-in switch for the live gateway. */
const LIVE_ENV = 'DSH_PATSNAP_LIVE'

/** A number the trial account has served in manual probes. */
const LIVE_NUMBER = 'CN115690481A'

function skipReason(): string | undefined {
  if (process.env[LIVE_ENV] !== '1') return `set ${LIVE_ENV}=1 to call the live PatSnap gateway`
  if ((process.env.PATSNAP_API_KEY ?? '').trim().length === 0) return 'set PATSNAP_API_KEY to call the live PatSnap gateway'
  return undefined
}

const reason = skipReason()

describe.skipIf(reason !== undefined)('PatSnap P020 against the live gateway', () => {
  it('resolves a PDF link and reports the billing amount', async () => {
    const key = process.env.PATSNAP_API_KEY as string
    const channel = new PatsnapChannel({ apiKey: key, batchSize: 5 })
    const result = await channel.pdfLinks([LIVE_NUMBER])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.pdfUrl).toMatch(/^https:\/\//)
    expect(result.items[0]?.resolvedNumber === undefined || result.items[0].resolvedNumber.length > 0).toBe(true)
    expect(result.amount).toBeGreaterThan(0)
  }, 60_000)
})
