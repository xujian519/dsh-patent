// nuo search provider factory: source-hit mapping to the { title, snippet, url }
// stage vocabulary, with the patent number as the title fallback and a five-hit
// default cap.
import { describe, expect, it, vi } from 'vitest'
import { createNuoSearchProvider } from '@deepseek-ai/dsh-patent-data'
import type { PatentSearchResult } from '@deepseek-ai/nuo-patent'

describe('createNuoSearchProvider', () => {
  it('maps source hits to the stage vocabulary, falling back to the patent number', async () => {
    const search = vi.fn(async (): Promise<PatentSearchResult> => ({
      query: 'thermal',
      total: 2,
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
        {
          patent: 'CN115690481A',
          title: '',
          assignee: '',
          publication_date: '',
          priority_date: '',
          abstract: 'A cooling structure.',
          url: 'https://patents.google.com/patent/CN115690481A',
        },
      ],
      warnings: [],
    }))
    const provider = createNuoSearchProvider({ search })

    const hits = await provider.search!('thermal', { maxResults: 3 })

    expect(search).toHaveBeenCalledWith('thermal', { limit: 3 })
    expect(hits).toEqual([
      {
        title: 'Thermal management system',
        snippet: 'A thermal management system.',
        url: 'https://patents.google.com/patent/US11452699B2',
        publicationDate: '2022-09-27',
      },
      {
        title: 'CN115690481A',
        snippet: 'A cooling structure.',
        url: 'https://patents.google.com/patent/CN115690481A',
      },
    ])
  })

  it('defaults the hit cap to five', async () => {
    const search = vi.fn(async (): Promise<PatentSearchResult> => ({
      query: 'thermal',
      total: 0,
      hits: [],
      warnings: [],
    }))
    const provider = createNuoSearchProvider({ search })

    expect(await provider.search!('thermal')).toEqual([])
    expect(search).toHaveBeenCalledWith('thermal', { limit: 5 })
  })

  it('propagates errors from the underlying search (F-PAT-038)', async () => {
    const search = vi.fn(async (): Promise<PatentSearchResult> => {
      throw new Error('nuo connection lost')
    })
    const provider = createNuoSearchProvider({ search })
    await expect(provider.search!('thermal')).rejects.toThrow('nuo connection lost')
  })

  it('propagates timeouts from the underlying search (F-PAT-038)', async () => {
    const search = vi.fn(async (): Promise<PatentSearchResult> => {
      throw new Error('timeout')
    })
    const provider = createNuoSearchProvider({ search })
    await expect(provider.search!('thermal')).rejects.toThrow('timeout')
  })
})
