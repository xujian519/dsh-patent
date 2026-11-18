// 上游来源：Mady 项目 `domains/config/style_test.go`：
// `TestSystemPrompt`（含 Tone/Voice/Anti-Patterns/Disclaimers/Citation/Output Conventions 全段）、
// `TestSystemPrompt_Minimal`（空段不输出标题）、`TestFindStyleByName`。
// `ToRenderStyle`、`DisclaimerFor` 在上游由 `domains/config/project.go`
// 之外的调用方使用，本包按 `style.go` 的实现逐分支覆盖。

import { describe, expect, it } from 'vitest'
import { disclaimerFor, findStyleByName, systemPrompt, toRenderStyle } from '../src/projection.ts'
import type { DocumentStyle, StyleSections } from '../src/types.ts'

/** Build a style whose every section keeps its empty value. */
function styleOf(sections: Partial<StyleSections>, name = 'minimal', domain = 'chat'): DocumentStyle {
  return {
    name,
    domain,
    version: '1.0',
    sections: {
      tone: { formality: '', perspective: '', language: '' },
      voice: { principles: [] },
      antiPatterns: [],
      disclaimers: new Map<string, string>(),
      citation: { style: '', format: '' },
      outputConventions: { confidenceLabel: false, weakVisual: false },
      ...sections,
    },
  }
}

/** The upstream `TestSystemPrompt` style. */
const FULL_STYLE = styleOf({
  tone: { formality: 'professional', perspective: 'third', language: 'zh-CN' },
  voice: { principles: ['如实呈现', '留有余地'] },
  antiPatterns: [
    { word: '绝对', replace: '通常', severity: 'block' },
    { word: '百分百', replace: '大概率', severity: 'warn' },
  ],
  disclaimers: new Map([['patent_analysis', '本分析由 AI 辅助生成。']]),
  citation: { style: 'inline', format: '[{id}]' },
  outputConventions: { confidenceLabel: true, weakVisual: true },
}, 'patent-standard', 'patent')

describe('systemPrompt', () => {
  it('renders the upstream style with every section', () => {
    const prompt = systemPrompt(FULL_STYLE)
    expect(prompt).toContain('<!-- Document Style Guide -->')
    expect(prompt).toContain('Style: patent-standard (domain: patent, version: 1.0)')
    expect(prompt).toContain('## Tone')
    expect(prompt).toContain('- Formality: professional')
    expect(prompt).toContain('- Perspective: third person')
    expect(prompt).toContain('- Language: zh-CN')
    expect(prompt).toContain('## Voice Principles')
    expect(prompt).toContain('- 如实呈现')
    expect(prompt).toContain('- [BLOCK] Never use "绝对" → use "通常" instead')
    expect(prompt).toContain('- [WARN] Never use "百分百" → use "大概率" instead')
    expect(prompt).toContain('## Required Disclaimers')
    expect(prompt).toContain('- patent_analysis: 本分析由 AI 辅助生成。')
    expect(prompt).toContain('## Citation Format')
    expect(prompt).toContain('- Style: inline')
    expect(prompt).toContain('- Format: [{id}]')
    expect(prompt).toContain('## Output Conventions')
    expect(prompt).toContain('- Attach confidence labels to all analytical conclusions')
    expect(prompt).toContain('- De-emphasize low-confidence content visually')
    expect(prompt).toContain('<!-- End Document Style Guide -->')
    expect(prompt.endsWith('<!-- End Document Style Guide -->')).toBe(true)
  })

  it('omits every section the style leaves empty', () => {
    const prompt = systemPrompt(styleOf({}))
    expect(prompt).toContain('Style: minimal (domain: chat, version: 1.0)')
    for (const heading of ['## Tone', '## Voice Principles', '## Anti-Patterns', '## Required Disclaimers', '## Citation Format', '## Output Conventions']) {
      expect(prompt).not.toContain(heading)
    }
  })

  it('renders each tone parameter the style declares', () => {
    expect(systemPrompt(styleOf({ tone: { formality: 'casual', perspective: '', language: '' } }))).toContain('- Formality: casual')
    expect(systemPrompt(styleOf({ tone: { formality: 'casual', perspective: '', language: '' } }))).not.toContain('Perspective')
    expect(systemPrompt(styleOf({ tone: { formality: '', perspective: 'second', language: '' } }))).toContain('- Perspective: second person')
    expect(systemPrompt(styleOf({ tone: { formality: '', perspective: '', language: 'en-US' } }))).toContain('- Language: en-US')
  })

  it('renders the citation format only when the style declares one', () => {
    const withoutFormat = systemPrompt(styleOf({ citation: { style: 'footnote', format: '' } }))
    expect(withoutFormat).toContain('- Style: footnote')
    expect(withoutFormat).not.toContain('- Format:')
  })

  it('renders one output convention at a time', () => {
    const labels = systemPrompt(styleOf({ outputConventions: { confidenceLabel: true, weakVisual: false } }))
    expect(labels).toContain('- Attach confidence labels to all analytical conclusions')
    expect(labels).not.toContain('De-emphasize')
    const weak = systemPrompt(styleOf({ outputConventions: { confidenceLabel: false, weakVisual: true } }))
    expect(weak).toContain('- De-emphasize low-confidence content visually')
    expect(weak).not.toContain('Attach confidence labels')
  })
})

describe('disclaimerFor', () => {
  const style = styleOf({
    disclaimers: new Map([
      ['patent_drafting', '草稿免责声明'],
      ['patent_analysis', '分析免责声明'],
    ]),
  }, 'patent-standard', 'patent')

  it('selects the disclaimer of the template category', () => {
    expect(disclaimerFor(style, 'claims')).toBe('草稿免责声明')
    expect(disclaimerFor(style, 'specification')).toBe('草稿免责声明')
    expect(disclaimerFor(style, 'oa-response')).toBe('分析免责声明')
    expect(disclaimerFor(style, 'disclosure')).toBe('分析免责声明')
  })

  it('falls back to the domain disclaimer when the category has none', () => {
    expect(disclaimerFor(style, 'unknown')).toBe('分析免责声明')
  })

  it('returns the empty string when neither applies', () => {
    const chat = styleOf({ disclaimers: new Map([['generated_content', '仅供参考']]) })
    expect(disclaimerFor(chat, 'claims')).toBe('')
  })

  it('prefers the domain fallback over an empty category entry', () => {
    const draftingMissing = styleOf({ disclaimers: new Map([['patent_analysis', '分析免责声明']]) }, 'patent-standard', 'patent')
    expect(disclaimerFor(draftingMissing, 'claims')).toBe('分析免责声明')
  })
})

describe('toRenderStyle', () => {
  it('carries the style name and the category disclaimer', () => {
    const style = styleOf({ disclaimers: new Map([['patent_analysis', '分析免责声明']]) }, 'patent-standard', 'patent')
    expect(toRenderStyle(style, 'oa-response')).toEqual({ name: 'patent-standard', disclaimer: '分析免责声明' })
  })

  it('carries an empty disclaimer when none applies', () => {
    expect(toRenderStyle(styleOf({}), 'claims')).toEqual({ name: 'minimal', disclaimer: '' })
  })
})

describe('style lookups', () => {
  const styles = [styleOf({}, 'a', 'patent'), styleOf({}, 'b', 'patent'), styleOf({}, 'c', 'legal')]

  it('finds a style by name', () => {
    expect(findStyleByName(styles, 'b')?.domain).toBe('patent')
    expect(findStyleByName(styles, 'gamma')).toBeUndefined()
  })
})
