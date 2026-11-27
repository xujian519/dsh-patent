// Port of Sati tests/patent/data/nuo/mapper.spec.ts: nuo PatentData JSON-string
// fields map to structured arrays; parseJsonArray is lenient.
import { describe, expect, it } from 'vitest'
import type { PatentData } from '@deepseek-ai/nuo-patent'
import { mapPatentData, parseJsonArray } from '@deepseek-ai/dsh-patent-data'

/** A nuo PatentData fixture carrying the JSON-string array fields. */
function makePatentData(): PatentData {
  return {
    title: 'Thermal management system',
    application_number: 'US17/123,456',
    inventor_name: JSON.stringify([{ inventor_name: 'Alice Zhang' }, { inventor_name: 'Bob Li' }]),
    assignee_name_orig: JSON.stringify([{ assignee_name: 'Apple Inc.' }]),
    assignee_name_current: JSON.stringify([{ assignee_name: 'Apple Inc.' }]),
    pub_date: '2022-09-27',
    filing_date: '2019-12-31',
    priority_date: '2019-12-31',
    grant_date: '2022-09-27',
    expiration_date: '2032-04-08',
    legal_status: 'Active',
    ifi_status: 'Active, expires 2032-04-08',
    estimated_expiration: '2032-04-08',
    pdf_url: 'https://patentimages.storage.googleapis.com/.../US11452699B2.pdf',
    classifications: JSON.stringify(['G06F1/20', 'H05K7/20']),
    forward_cite_no_family: JSON.stringify([
      { patent_number: 'US11563056B2', priority_date: '2020-01-01', pub_date: '2023-01-24' },
    ]),
    forward_cite_yes_family: '[]',
    backward_cite_no_family: JSON.stringify([
      { patent_number: 'US10123456B2', priority_date: '2010-05-05', pub_date: '2012-01-01' },
    ]),
    backward_cite_yes_family: '[]',
    abstract_text: 'A thermal management system for electronic devices.',
  }
}

describe('parseJsonArray', () => {
  it('parses a valid JSON array', () => {
    expect(parseJsonArray<string>('["a","b"]')).toEqual(['a', 'b'])
  })

  it('returns [] for an empty string', () => {
    expect(parseJsonArray<string>('')).toEqual([])
  })

  it('returns [] for invalid JSON without throwing', () => {
    expect(parseJsonArray<string>('{not json')).toEqual([])
  })

  it('returns [] for a non-array JSON value', () => {
    expect(parseJsonArray<string>('{"a":1}')).toEqual([])
  })
})

describe('mapPatentData', () => {
  it('maps JSON-string fields to structured arrays', () => {
    const mapped = mapPatentData(makePatentData(), 'US11452699B2', 'https://patents.google.com/patent/US11452699B2')

    expect(mapped.patent).toBe('US11452699B2')
    expect(mapped.title).toBe('Thermal management system')
    expect(mapped.inventors).toEqual(['Alice Zhang', 'Bob Li'])
    expect(mapped.assigneesCurrent).toEqual(['Apple Inc.'])
    expect(mapped.assigneesOriginal).toEqual(['Apple Inc.'])
    expect(mapped.classifications).toEqual(['G06F1/20', 'H05K7/20'])
    expect(mapped.legalStatus).toBe('Active')
    expect(mapped.estimatedExpiration).toBe('2032-04-08')
  })

  it('merges family and non-family citations', () => {
    const mapped = mapPatentData(makePatentData(), 'US11452699B2', 'url')
    expect(mapped.forwardCites.length).toBe(1)
    expect(mapped.forwardCites[0]?.patent_number).toBe('US11563056B2')
    expect(mapped.backwardCites.length).toBe(1)
    expect(mapped.backwardCites[0]?.patent_number).toBe('US10123456B2')
  })

  it('maps empty/invalid JSON fields to [] without throwing', () => {
    const data = makePatentData()
    data.inventor_name = ''
    data.classifications = 'not json'
    data.backward_cite_no_family = '[]'
    const mapped = mapPatentData(data, 'US11452699B2', 'url')
    expect(mapped.inventors).toEqual([])
    expect(mapped.classifications).toEqual([])
    expect(mapped.backwardCites).toEqual([])
  })

  it('drops non-string name entries', () => {
    const data = makePatentData()
    data.inventor_name = JSON.stringify([{ inventor_name: 42 }, { inventor_name: 'Alice Zhang' }])
    data.assignee_name_orig = JSON.stringify([{ assignee_name: null }])
    const mapped = mapPatentData(data, 'US11452699B2', 'url')
    expect(mapped.inventors).toEqual(['Alice Zhang'])
    expect(mapped.assigneesOriginal).toEqual([])
  })

  it('tolerates null elements in the engine JSON arrays', () => {
    const data = makePatentData()
    data.inventor_name = JSON.stringify([null, { inventor_name: 'Alice Zhang' }])
    data.assignee_name_current = JSON.stringify([null])
    data.classifications = JSON.stringify([null, 'H04L9/40', 42])
    const mapped = mapPatentData(data, 'US11452699B2', 'url')
    expect(mapped.inventors).toEqual(['Alice Zhang'])
    expect(mapped.assigneesCurrent).toEqual([])
    expect(mapped.classifications).toEqual(['H04L9/40'])
  })

  it('uses explicit patent/url params and tolerates extra keys', () => {
    const data = makePatentData()
    const withExtras = data as PatentData & { url?: string; patent?: string }
    withExtras.url = 'https://patents.google.com/patent/US11452699B2/en'
    withExtras.patent = 'US11452699B2'
    data.classifications = JSON.stringify(['G06F 1/20', 'H05K 7/20'])
    data.backward_cite_no_family = JSON.stringify([
      { patent_number: 'US10123456B2', priority_date: '2010-05-05', pub_date: '2012-01-01', extra: 'ignored' },
    ])
    const mapped = mapPatentData(data, 'US11452699B2', 'https://patents.google.com/patent/US11452699B2')
    expect(mapped.patent).toBe('US11452699B2')
    expect(mapped.url).toBe('https://patents.google.com/patent/US11452699B2')
    expect(mapped.classifications).toEqual(['G06F 1/20', 'H05K 7/20'])
    expect(mapped.backwardCites[0]?.patent_number).toBe('US10123456B2')
    expect((mapped.backwardCites[0] as unknown as Record<string, unknown>).extra).toBe('ignored')
  })
})
