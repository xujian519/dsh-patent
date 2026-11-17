import { describe, expect, it } from 'vitest'
import { inspectPdfBody, isHtmlContentType } from '@deepseek-ai/dsh-patent-core'
import {
  datedOutputDir,
  MIN_PDF_BYTES,
  PDF_MAGIC,
} from '../src/pdf-download.ts'

describe('isHtmlContentType', () => {
  it('matches HTML regardless of case and ignores other types', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true)
    expect(isHtmlContentType('TEXT/HTML')).toBe(true)
    expect(isHtmlContentType('application/pdf')).toBe(false)
  })
})

describe('inspectPdfBody', () => {
  it('accepts a body at the minimum size with the PDF magic', () => {
    const body = Buffer.concat([Buffer.from(PDF_MAGIC), Buffer.alloc(MIN_PDF_BYTES - PDF_MAGIC.length)])
    expect(inspectPdfBody(body)).toBeUndefined()
  })

  it('reports bodies below the minimum size', () => {
    expect(inspectPdfBody(Buffer.from(PDF_MAGIC))).toEqual({ code: 'too-small', bytes: PDF_MAGIC.length })
  })

  it('reports the leading bytes when the magic is missing', () => {
    const body = Buffer.alloc(MIN_PDF_BYTES, 'x')
    expect(inspectPdfBody(body)).toEqual({ code: 'magic', prefix: 'xxxxx' })
  })
})

describe('datedOutputDir', () => {
  it('uses the local date and zero-pads month and day', () => {
    const now = new Date(2024, 0, 5)
    expect(datedOutputDir('/tmp/work', 'patents', now)).toBe('/tmp/work/patents/2024-01-05')
  })

  it('defaults to the current clock', () => {
    expect(datedOutputDir('/tmp/work', 'papers')).toMatch(/\/tmp\/work\/papers\/\d{4}-\d{2}-\d{2}$/u)
  })
})
