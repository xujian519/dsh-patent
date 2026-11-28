import { describe, expect, it, vi } from 'vitest'
import { createPatsnapFallbackResolver } from '../src/tool/patent-pdf-download-fallback.ts'
import { PATSNAP_CHANNEL } from '../src/tool/internal/upstream-channel.ts'
import type { FallbackRequest } from '../src/tool/patent-pdf-download.ts'
import type { PatsnapPdfLinkItem } from '@deepseek-ai/dsh-patent-data'

const requests: FallbackRequest[] = [
  { patent: 'CN115690481A', reason: 'no PDF link' },
  { patent: 'US11452699B2', reason: 'HTTP 403' },
  { patent: 'EP2458380B1', reason: 'no PDF link' },
  { patent: 'WO2023123456A1', reason: 'timeout' },
]

/** A channel stand-in returning the items the case needs. */
function channelWith(items: PatsnapPdfLinkItem[]) {
  return { pdfLinks: vi.fn(async () => ({ items, amount: 0 })) }
}

describe('createPatsnapFallbackResolver', () => {
  it('returns nothing when the service or the channel is absent', async () => {
    await expect(createPatsnapFallbackResolver(() => undefined)(requests, { timeoutMs: 1 })).resolves.toEqual([])
    await expect(
      createPatsnapFallbackResolver(() => ({ createPatsnapChannel: () => undefined }))(requests, { timeoutMs: 1 }),
    ).resolves.toEqual([])
  })

  it('maps served numbers, misses and PDF-less records to fallback links', async () => {
    const channel = channelWith([
      { number: 'CN115690481A', pdfUrl: 'https://data-pdf.example/CN.pdf', resolvedNumber: 'CN115690481B' },
      { number: 'US11452699B2', code: 'no_pdf', error: '记录没有 PDF' },
      { number: 'EP2458380B1', code: 'no_pdf' },
    ])
    const resolver = createPatsnapFallbackResolver(() => ({ createPatsnapChannel: () => channel }))
    const links = await resolver(requests, { timeoutMs: 25 })

    expect(channel.pdfLinks).toHaveBeenCalledWith(
      ['CN115690481A', 'US11452699B2', 'EP2458380B1', 'WO2023123456A1'],
      { timeoutMs: 25 },
    )
    expect(links).toEqual([
      { patent: 'CN115690481A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/CN.pdf', resolvedNumber: 'CN115690481B' },
      { patent: 'US11452699B2', channel: PATSNAP_CHANNEL, error: '记录没有 PDF' },
      { patent: 'EP2458380B1', channel: PATSNAP_CHANNEL, error: 'PatSnap 没有该号的 PDF' },
      { patent: 'WO2023123456A1', channel: PATSNAP_CHANNEL, error: 'PatSnap 未返回该号' },
    ])
  })

  it('omits an absent resolvedNumber', async () => {
    const channel = channelWith([{ number: 'CN115690481A', pdfUrl: 'https://data-pdf.example/CN.pdf' }])
    const resolver = createPatsnapFallbackResolver(() => ({ createPatsnapChannel: () => channel }))
    const [link] = await resolver([requests[0] as FallbackRequest], { timeoutMs: 1 })
    expect(link).toEqual({ patent: 'CN115690481A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/CN.pdf' })
  })
})
