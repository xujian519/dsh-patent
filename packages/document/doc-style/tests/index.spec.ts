// 包门面测试：`src/index.ts` 只做再导出，本用例固定对外表面，
// 使入口模块在覆盖率统计中被加载并保持 100%。

import { describe, expect, it } from 'vitest'
import * as Pkg from '../src/index.ts'
import { loadStyles } from '../src/load.ts'

describe('@deepseek-ai/dsh-doc-style package surface', () => {
  it('exports the asset vocabulary', () => {
    expect(Pkg.FORMALITY_LEVELS).toEqual(['casual', 'professional', 'academic'])
    expect(Pkg.PERSPECTIVES).toEqual(['first', 'second', 'third'])
    expect(Pkg.ANTI_PATTERN_SEVERITIES).toEqual(['block', 'warn'])
    expect(Pkg.CITATION_STYLES).toEqual(['', 'inline', 'footnote', 'endnote'])
    expect(Pkg.STYLE_FILE_SUFFIX).toBe('.yaml')
    expect(Pkg.DISCLAIMER_CATEGORY_KEYS).toEqual({
      specification: 'patent_drafting',
      claims: 'patent_drafting',
      'patent-report': 'patent_drafting',
      'oa-response': 'patent_analysis',
      disclosure: 'patent_analysis',
    })
    expect(typeof Pkg.DocumentStyleError).toBe('function')
  })

  it('exports the loader and the projections', () => {
    expect(typeof Pkg.loadStyles).toBe('function')
    expect(typeof Pkg.loadStyleFile).toBe('function')
    expect(typeof Pkg.parseStyleAsset).toBe('function')
    expect(typeof Pkg.stylesDirectory).toBe('function')
    expect(typeof Pkg.systemPrompt).toBe('function')
    expect(typeof Pkg.toRenderStyle).toBe('function')
    expect(typeof Pkg.disclaimerFor).toBe('function')
    expect(typeof Pkg.findStyleByName).toBe('function')
    expect(typeof Pkg.placeholderBracePattern).toBe('function')
  })

  it('projects a packaged style end to end', () => {
    const styles = loadStyles([Pkg.stylesDirectory()])
    const patent = Pkg.findStyleByName(styles, 'patent-standard')
    expect(patent).toBeDefined()
    if (patent === undefined) throw new Error('patent-standard is packaged')
    expect(Pkg.toRenderStyle(patent, 'specification').disclaimer).toContain('专利代理人审阅')
  })
})
