import { describe, expect, it } from 'vitest'
import { compileWritingPatternIndex, compileWritingSkills, escapeXmlText } from '../src/skill-compiler.ts'
import { loadPatternStore } from '../src/pattern-store.ts'
import { makePattern } from './fixtures/patterns.ts'

describe('compileWritingSkills', () => {
  it('returns nothing to inject when there is no pattern', () => {
    expect(compileWritingSkills([])).toBe('')
  })

  it('compiles context, steps, dos, and donts as one block', () => {
    const pattern = makePattern({
      id: 'wp-x',
      name: '两段式独权',
      category: 'claim_drafting',
      summary: '前序写共有特征，特征部写改进',
      context: '适用于结构改进型实用新型',
      steps: [
        { order: 1, name: '确定主题', instruction: '写整体装置', example: '一种储罐' },
        { order: 2, name: '写特征部', instruction: '声称所述……' },
      ],
      dos: [{ rule: '保护主题写整体装置' }],
      donts: [{ rule: '避免大约、左右' }],
    })
    expect(compileWritingSkills([pattern])).toBe([
      '<writing_skills>',
      '  <skill id="wp-x">',
      '    <name>两段式独权</name>',
      '    <category>claim_drafting</category>',
      '    <summary>前序写共有特征，特征部写改进</summary>',
      '    <context>适用于结构改进型实用新型</context>',
      '    <steps>',
      '      <step order="1">',
      '        <name>确定主题</name>',
      '        <instruction>写整体装置</instruction>',
      '        <example>一种储罐</example>',
      '      </step>',
      '      <step order="2">',
      '        <name>写特征部</name>',
      '        <instruction>声称所述……</instruction>',
      '      </step>',
      '    </steps>',
      '    <dos>',
      '      <principle>保护主题写整体装置</principle>',
      '    </dos>',
      '    <donts>',
      '      <principle>避免大约、左右</principle>',
      '    </donts>',
      '  </skill>',
      '</writing_skills>',
    ].join('\n'))
  })

  it('omits the sections a pattern leaves empty', () => {
    const pattern = makePattern({ id: 'wp-bare', name: 'Bare', summary: 'Summary' })
    expect(compileWritingSkills([pattern])).toBe([
      '<writing_skills>',
      '  <skill id="wp-bare">',
      '    <name>Bare</name>',
      '    <category>claim_drafting</category>',
      '    <summary>Summary</summary>',
      '  </skill>',
      '</writing_skills>',
    ].join('\n'))
  })

  it('keeps the given pattern order inside one block', () => {
    const first = makePattern({ id: 'a', name: 'A', summary: 'SA' })
    const second = makePattern({ id: 'b', name: 'B', summary: 'SB' })
    const block = compileWritingSkills([second, first])
    expect(block.indexOf('id="b"')).toBeLessThan(block.indexOf('id="a"'))
    expect(block.match(/<writing_skills>/gu)).toHaveLength(1)
  })

  it('escapes XML-significant characters in authored text', () => {
    const pattern = makePattern({
      id: 'wp-amp',
      name: 'A & B <C>',
      summary: '"引号" 与 \'单引号\'',
      dos: [{ rule: '5 > 3' }],
    })
    const block = compileWritingSkills([pattern])
    expect(block).toContain('<name>A &amp; B &lt;C&gt;</name>')
    expect(block).toContain('<summary>&quot;引号&quot; 与 &apos;单引号&apos;</summary>')
    expect(block).toContain('<principle>5 &gt; 3</principle>')
    expect(block).not.toContain('<C>')
  })

  it('escapes the five predefined entities exactly once each', () => {
    expect(escapeXmlText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;')
    expect(escapeXmlText('&amp;')).toBe('&amp;amp;')
    expect(escapeXmlText('无特殊字符')).toBe('无特殊字符')
  })

  it('compiles the shipped corpus into a block per pattern', () => {
    const block = compileWritingSkills(loadPatternStore().byCategory('oa_inventiveness'))
    expect(block.startsWith('<writing_skills>\n  <skill id="wp-oa-inventiveness-3step">')).toBe(true)
    expect(block.endsWith('</writing_skills>')).toBe(true)
    expect(block).toContain('<step order="3">')
  })
})

describe('compileWritingPatternIndex', () => {
  it('returns nothing to inject when there is no pattern', () => {
    expect(compileWritingPatternIndex([])).toBe('')
  })

  it('indexes id, category, and name without the pattern body', () => {
    const pattern = makePattern({
      id: 'wp-x',
      name: '两段式独权',
      category: 'claim_drafting',
      summary: '前序写共有特征，特征部写改进',
      steps: [{ order: 1, name: '确定主题', instruction: '写整体装置' }],
    })
    expect(compileWritingPatternIndex([pattern])).toBe([
      '<pattern_index>',
      '  <pattern id="wp-x" category="claim_drafting">两段式独权</pattern>',
      '</pattern_index>',
    ].join('\n'))
  })

  it('keeps the given order and escapes authored names', () => {
    const first = makePattern({ id: 'a', name: 'A & B' })
    const second = makePattern({ id: 'b', name: 'B' })
    const block = compileWritingPatternIndex([second, first])
    expect(block.indexOf('id="b"')).toBeLessThan(block.indexOf('id="a"'))
    expect(block).toContain('A &amp; B')
    expect(block).not.toContain('<steps>')
  })
})
