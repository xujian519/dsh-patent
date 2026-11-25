import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_PDF_TIMEOUT_MS } from '@deepseek-ai/dsh-patent-document'

describe('Config', () => {
  it('leaves outputRoot unset', () => {
    const config = Config({})
    expect(config.outputRoot).toBeUndefined()
    expect(config.workbenchCaseRoot).toBeUndefined()
    expect(config.chromePath).toBeUndefined()
  })

  it('accepts an explicit chromePath and outputRoot', () => {
    const config = Config({ chromePath: '/usr/bin/chrome', outputRoot: 'out/docs' })
    expect(config.chromePath).toBe('/usr/bin/chrome')
    expect(config.outputRoot).toBe('out/docs')
  })

  it('rejects a non-string chromePath', () => {
    expect(() => Config({ chromePath: 42 as unknown as string })).toThrow()
  })

  it('defaults pdfTimeoutMs to the renderer default and accepts a slower deployment', () => {
    expect(Config({}).pdfTimeoutMs).toBe(DEFAULT_PDF_TIMEOUT_MS)
    expect(Config({ pdfTimeoutMs: 300_000 }).pdfTimeoutMs).toBe(300_000)
    expect(() => Config({ pdfTimeoutMs: 0 })).toThrow()
  })
})
