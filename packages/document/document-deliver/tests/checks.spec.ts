/**
 * Deterministic document checks: residual placeholders and their fenced
 * exemption, same-document anchors, empty sections, style forbidden words, and
 * the declared character budget — plus the cross-package property that every
 * placeholder the gate blocks is one the template engine can fill by name.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { AntiPattern, DocumentStyle, StyleSections } from '@deepseek-ai/dsh-doc-style'
import { extractPlaceholders, substitutePlaceholders, templatesDirectory } from '@deepseek-ai/dsh-doc-template'
import { checkDocumentText, DOCUMENT_CHECK_IDS } from '../src/checks.ts'

/** A style whose sections default to empty, so a test declares only what it exercises. */
function style(antiPatterns: readonly AntiPattern[]): DocumentStyle {
  const sections: StyleSections = {
    tone: { formality: '', perspective: '', language: '' },
    voice: { principles: [] },
    antiPatterns,
    disclaimers: new Map(),
    citation: { style: '', format: '' },
    outputConventions: { confidenceLabel: false, weakVisual: false },
  }
  return { name: 'test-style', domain: 'test', version: '1', sections }
}

const FORBIDDEN = style([
  { word: '绝对', replace: '通常', severity: 'block' },
  { word: '完全', replace: '基本', severity: 'warn' },
])

describe('checkDocumentText', () => {
  it('reports nothing for a document that passes every check', () => {
    expect(checkDocumentText('# 报告\n\n正文内容。\n\n## 结论\n\n有内容。\n')).toEqual([])
  })

  it('exposes the check ids a caller can key on', () => {
    expect([...DOCUMENT_CHECK_IDS]).toEqual(['placeholder', 'broken_anchor', 'empty_section', 'anti_pattern', 'length_budget'])
  })

  it('blocks a residual placeholder outside a code fence and only warns inside one', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n客户名称：{{client_name}}\n')).toEqual([
      { check: 'placeholder', level: 'block', detail: '第 5 行仍有残余占位符 "{{client_name}}"', line: 5 },
    ])

    expect(checkDocumentText('# 报告\n\n正文。\n\n```\n{{client_name}}\n```\n')).toEqual([
      { check: 'placeholder', level: 'warn', detail: '第 6 行仍有残余占位符 "{{client_name}}"', line: 6 },
    ])
  })

  it('reports an HTML placeholder inside code, a comment, or an attribute instead of blocking it', () => {
    const cases: readonly string[] = [
      '<pre><code>{{case_id}}</code></pre>',
      '<code>{{case_id}}</code>',
      '<!-- {{case_id}} -->',
      '<img src="x.png" alt="[TBD]">',
    ]
    for (const html of cases) {
      const findings = checkDocumentText(html, { format: 'html' })
        .filter(finding => finding.check === 'placeholder')
      expect(findings.map(finding => finding.level), html).toEqual(['warn'])
    }
  })

  it('gives the same placeholder verdict to the same content as Markdown and as HTML', () => {
    const markdown = '```\n{{case_id}}\n```\n'
    const html = '<pre><code>{{case_id}}</code></pre>\n'
    const level = (text: string, options: { format?: 'markdown' | 'html' }): string | undefined =>
      checkDocumentText(text, options).find(finding => finding.check === 'placeholder')?.level
    expect(level(markdown, {})).toBe('warn')
    expect(level(html, { format: 'html' })).toBe(level(markdown, {}))
  })

  it('reports an HTML placeholder in an attribute that follows a quoted value holding >', () => {
    // A `>` inside one attribute value does not end the tag, so the attributes
    // behind it are still attributes and not visible body text.
    const html = '<img src="x.png" alt="a>b" title="{{title}}">'
    const findings = checkDocumentText(html, { format: 'html' })
      .filter(finding => finding.check === 'placeholder')
    expect(findings.map(finding => finding.level)).toEqual(['warn'])
  })

  it('reports an HTML placeholder in a script or style body instead of blocking it', () => {
    // The element list matches the one the body-text projection already uses:
    // a reader sees neither a script body nor a stylesheet.
    for (const html of ['<script>var x = "{{y}}";</script><p>正文</p>', '<style>.a{content:"{{z}}"}</style><p>正文</p>']) {
      const findings = checkDocumentText(html, { format: 'html' })
        .filter(finding => finding.check === 'placeholder')
      expect(findings.map(finding => finding.level), html).toEqual(['warn'])
    }
  })

  it('still blocks a placeholder after a stray closing tag', () => {
    // A closing tag ends a range; it does not open one whose content runs to
    // the end of the document.
    for (const html of ['<p>正文</p></pre><p>{{visible}}</p>', '</code><p>{{visible}}</p>']) {
      const findings = checkDocumentText(html, { format: 'html' })
        .filter(finding => finding.check === 'placeholder')
      expect(findings.map(finding => finding.level), html).toEqual(['block'])
    }
  })

  it('still blocks an HTML placeholder that sits in visible body text', () => {
    expect(checkDocumentText('<p>客户名称：{{client_name}}</p>', { format: 'html' })).toEqual([
      { check: 'placeholder', level: 'block', detail: '第 1 行仍有残余占位符 "{{client_name}}"', line: 1 },
    ])
  })

  it('recognizes every marker form and reports the fenced occurrences after the unfenced ones', () => {
    const findings = checkDocumentText([
      '# 报告', '', 'Lorem ipsum 待补充。', '', '```', '[TBD] [REPLACE]', '```', '',
    ].join('\n'))
    expect(findings.map(finding => finding.detail)).toEqual([
      '第 3 行仍有残余占位符 "Lorem ipsum"',
      '第 3 行仍有残余占位符 "待补充"',
      '第 6 行仍有残余占位符 "[TBD]"',
      '第 6 行仍有残余占位符 "[REPLACE]"',
    ])
    expect(findings.map(finding => finding.level)).toEqual(['block', 'block', 'warn', 'warn'])
  })

  it('blocks official-form blanks and the gate-recognized gap marker', () => {
    expect(checkDocumentText([
      '# 起诉状', '', '被告：[待填写：身份证号]', '', '事实：×××。', '', '理由：(写明事实)。', '',
    ].join('\n')).map(finding => finding.detail)).toEqual([
      '第 3 行仍有残余占位符 "待填写"',
      '第 5 行仍有残余占位符 "×××"',
      '第 7 行仍有残余占位符 "(写明"',
    ])
  })

  it('matches the bracketed markers without case', () => {
    expect(checkDocumentText('[placeholder]\n\n[todo] [xxx]\n').map(finding => finding.detail)).toEqual([
      '第 1 行仍有残余占位符 "[placeholder]"',
      '第 3 行仍有残余占位符 "[todo]"',
      '第 3 行仍有残余占位符 "[xxx]"',
    ])
  })

  it('caps one check at five findings and reports how many were left out', () => {
    const findings = checkDocumentText(Array.from({ length: 7 }, () => '{{slot}}').join('\n\n'))
    expect(findings).toHaveLength(6)
    expect(findings[5]).toEqual({ check: 'placeholder', level: 'block', detail: '另有 2 处同类问题未逐条列出' })
  })

  it('applies a configured per-check cap instead of the default', () => {
    const findings = checkDocumentText(Array.from({ length: 7 }, () => '{{slot}}').join('\n\n'), { maxFindingsPerCheck: 2 })
    expect(findings).toHaveLength(3)
    expect(findings[2]).toEqual({ check: 'placeholder', level: 'block', detail: '另有 5 处同类问题未逐条列出' })
  })

  it('warns about a fragment the document declares no anchor for', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n见 [结论](#结论)。\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 5 行链接到本文档未声明的锚点 "#结论"', line: 5 },
    ])
  })

  it('accepts heading slugs, explicit anchors, and GitHub collision suffixes', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n## 结论\n\n有内容。\n\n见 [结论](#结论)。\n')).toEqual([])
    expect(checkDocumentText('# 报告\n\n正文。\n\n<h2 id="custom">小节</h2>\n\n有内容。\n\n见 [该节](#custom)。\n')).toEqual([])
    expect(checkDocumentText('# 重复\n\n一二。\n\n# 重复\n\n三四。\n\n见 [第二次](#重复-1)。\n')).toEqual([])
    expect(checkDocumentText('# 重复\n\n一二。\n\n# 重复\n\n三四。\n\n见 [第三次](#重复-2)。\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 9 行链接到本文档未声明的锚点 "#重复-2"', line: 9 },
    ])
  })

  it('renders heading markup before slugging, as a renderer would', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n## `web_fetch` 用法\n\n有内容。\n\n见 [用法](#web_fetch-用法)。\n')).toEqual([])
    expect(checkDocumentText('# 报告\n\n正文。\n\n## **重点**：结论\n\n有内容。\n\n见 [结论](#重点结论)。\n')).toEqual([])
  })

  it('checks HTML fragments and decodes percent escapes', () => {
    expect(checkDocumentText('<h1>报告</h1>\n<p>正文。</p>\n<a href="#%E7%BB%93%E8%AE%BA">结论</a>\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 3 行链接到本文档未声明的锚点 "#结论"', line: 3 },
    ])
    expect(checkDocumentText('<h1>报告</h1>\n<p>正文。</p>\n<a href="#%zz">坏转义</a>\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 3 行链接到本文档未声明的锚点 "#%zz"', line: 3 },
    ])
  })

  it('ignores an empty fragment, a repeated fragment, and a link inside a code fence', () => {
    expect(checkDocumentText('<h1>报告</h1>\n<p>正文。</p>\n<a href="#">空</a>\n<a href="#x">一</a>\n<a href="#x">二</a>\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 4 行链接到本文档未声明的锚点 "#x"', line: 4 },
    ])
    expect(checkDocumentText('# 报告\n\n正文。\n\n```\n[x](#x)\n```\n')).toEqual([])
  })

  it('accepts the fragment a renderer answers at the document top', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n<a href="#top">回到顶部</a>\n')).toEqual([])
    // 反向：白名单只给渲染器惯例锚点，其它未声明的片段照样提示。
    expect(checkDocumentText('# 报告\n\n正文。\n\n<a href="#bottom">到底部</a>\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 5 行链接到本文档未声明的锚点 "#bottom"', line: 5 },
    ])
  })

  it('warns about a heading whose section holds nothing', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n## 待办\n\n## 结论\n\n完成。\n')).toEqual([
      { check: 'empty_section', level: 'warn', detail: '第 5 行的标题 "待办" 下没有任何内容', line: 5 },
    ])
    expect(checkDocumentText('<h1>报告</h1>\n<p>正文。</p>\n<h2>空节</h2>\n<h2>结论</h2>\n<p>完成。</p>\n')).toEqual([
      { check: 'empty_section', level: 'warn', detail: '第 3 行的标题 "空节" 下没有任何内容', line: 3 },
    ])
  })

  it('does not call an H1 empty when its first subheading is deeper', () => {
    // 干净文档的写法：H1 是文档标题，正文落在紧随其后的子标题下。
    expect(checkDocumentText('# 季度报告\n\n## 结论\n\n本季度交付 12 份文档。\n')).toEqual([])
    // 反向：H1 之后没有任何标题（或同级标题）时仍判空，例外只覆盖"子标题紧随"的写法。
    expect(checkDocumentText('# 只有标题\n')).toEqual([
      { check: 'empty_section', level: 'warn', detail: '第 1 行的标题 "只有标题" 下没有任何内容', line: 1 },
    ])
    expect(checkDocumentText('# 一\n\n# 二\n\n正文。\n')).toEqual([
      { check: 'empty_section', level: 'warn', detail: '第 1 行的标题 "一" 下没有任何内容', line: 1 },
    ])
  })

  it('treats a comment-only section as empty and a trailing heading as empty', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n## 空节\n\n<!-- 待填 -->\n')).toEqual([
      { check: 'empty_section', level: 'warn', detail: '第 5 行的标题 "空节" 下没有任何内容', line: 5 },
    ])
  })

  it('does not treat a fenced hash line as a heading', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n```sh\n# 注释\n```\n')).toEqual([])
  })

  it('ignores headings and explicit anchors inside a fence, because a fence registers nothing', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n```html\n<h2>样例</h2>\n<h2 id="anchor">样例</h2>\n```\n')).toEqual([])
  })

  it('treats an unterminated fence as extending to the end of the document', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n```\n{{slot}}\n')).toEqual([
      { check: 'placeholder', level: 'warn', detail: '第 6 行仍有残余占位符 "{{slot}}"', line: 6 },
    ])
  })

  it('carries the style severity of each forbidden word', () => {
    expect(checkDocumentText('# 报告\n\n正文。\n\n绝对可行，完全没问题。\n', { style: FORBIDDEN })).toEqual([
      { check: 'anti_pattern', level: 'block', detail: '第 5 行出现样式禁用词 "绝对"，建议改用 "通常"', line: 5 },
      { check: 'anti_pattern', level: 'warn', detail: '第 5 行出现样式禁用词 "完全"，建议改用 "基本"', line: 5 },
    ])
  })

  it('matches a forbidden word literally and without case', () => {
    const literalPattern = style([{ word: 'a+b', replace: 'a plus b', severity: 'warn' }])
    expect(checkDocumentText('aaab\n', { style: literalPattern })).toEqual([])
    expect(checkDocumentText('a+b\n', { style: literalPattern })).toEqual([
      { check: 'anti_pattern', level: 'warn', detail: '第 1 行出现样式禁用词 "a+b"，建议改用 "a plus b"', line: 1 },
    ])
    expect(checkDocumentText('todo\n', { style: style([{ word: 'TODO', replace: '待办', severity: 'block' }]) })).toEqual([
      { check: 'anti_pattern', level: 'block', detail: '第 1 行出现样式禁用词 "TODO"，建议改用 "待办"', line: 1 },
    ])
  })

  it('only reports a forbidden word the document quotes instead of using', () => {
    // 复述禁用词的写作规范，把词放进行内代码或围栏里——那是它在谈论这个词。
    expect(checkDocumentText('# 报告\n\n正文。\n\n复述规则：`绝对` 是要避开的词。\n', { style: FORBIDDEN })).toEqual([
      { check: 'anti_pattern', level: 'warn', detail: '第 5 行引用文本中出现样式禁用词 "绝对"（不影响判定）', line: 5 },
    ])
    expect(checkDocumentText('# 报告\n\n正文。\n\n```\n绝对\n```\n', { style: FORBIDDEN })).toEqual([
      { check: 'anti_pattern', level: 'warn', detail: '第 6 行引用文本中出现样式禁用词 "绝对"（不影响判定）', line: 6 },
    ])
    // 反向：正文里的 block 级词仍然拒绝登记，引用豁免不是绕过检查的通道。
    expect(checkDocumentText('# 报告\n\n正文。\n\n绝对可行。\n', { style: FORBIDDEN })).toEqual([
      { check: 'anti_pattern', level: 'block', detail: '第 5 行出现样式禁用词 "绝对"，建议改用 "通常"', line: 5 },
    ])
  })

  it('orders findings by line across the syntaxes and the anti-pattern list', () => {
    // The Markdown pass runs before the HTML one, so only the sort can put the
    // earlier line first.
    expect(checkDocumentText('<h1>报告</h1>\n<p>正文。</p>\n<a href="#c">c</a>\n[b](#b)\n')).toEqual([
      { check: 'broken_anchor', level: 'warn', detail: '第 3 行链接到本文档未声明的锚点 "#c"', line: 3 },
      { check: 'broken_anchor', level: 'warn', detail: '第 4 行链接到本文档未声明的锚点 "#b"', line: 4 },
    ])
    // The style lists "绝对" first, so only the sort can put line 1 first.
    expect(checkDocumentText('完全\n\n绝对\n', { style: FORBIDDEN }).map(finding => finding.line)).toEqual([1, 3])
  })

  it('reports a declared budget the document misses and stays silent inside the tolerance', () => {
    const text = `# 报告\n\n${'字'.repeat(100)}\n`
    expect(checkDocumentText(text, { charBudget: 100 })).toEqual([])
    expect(checkDocumentText(text, { charBudget: 300 })).toEqual([
      { check: 'length_budget', level: 'warn', detail: '全文 103 字，低于声明的 300 字预算（允许 240–360 字）' },
    ])
    expect(checkDocumentText(text, { charBudget: 80 })).toEqual([
      { check: 'length_budget', level: 'warn', detail: '全文 103 字，超出声明的 80 字预算（允许 64–96 字）' },
    ])
  })

  it('measures an HTML document body text, not its markup', () => {
    // 每段正文 19 个非空白字符；标签、注释、内联 CSS/JS 都不算正文。
    const body = '<p>本季度交付 12 份文档，来源：内部台账。</p>'
    const html = [
      '<!doctype html>',
      '<html lang="zh-CN"><head><meta charset="utf-8"><title></title>',
      '<style>body{font-family:sans-serif;color:#222}@media print{body{margin:0}}</style>',
      '<script>window.addEventListener("load",function(){console.log("ready")})</script>',
      '</head><body>',
      '<!-- 打印时隐藏 -->',
      body.repeat(5),
      '</body></html>',
    ].join('\n')
    // 正文 19 × 5 = 95 字，落在 100 字预算的 20% 容差内。
    expect(checkDocumentText(html, { charBudget: 100, format: 'html' })).toEqual([])
    // 同一份文件声明 10 字预算仍然报，且报的是正文的 95 字。
    expect(checkDocumentText(html, { charBudget: 10, format: 'html' })).toEqual([
      { check: 'length_budget', level: 'warn', detail: '全文 95 字，超出声明的 10 字预算（允许 8–12 字）' },
    ])
    // 反向：不声明 html 口径就按交付字节量，标签与内联 CSS/JS 一起算，误报超预算。
    expect(checkDocumentText(html, { charBudget: 100 }).map(finding => finding.check)).toEqual(['length_budget'])
  })

  it('reads HTML the way a renderer takes it, for the budget measure', () => {
    /** 用一次低于预算的提示读出正文口径实际量到的字数。 */
    const measured = (html: string): number => {
      const detail = checkDocumentText(html, { charBudget: 100, format: 'html' })[0]?.detail ?? ''
      return Number(/全文 (\d+) 字/u.exec(detail)?.[1])
    }
    expect(measured('正文')).toBe(2)
    expect(measured('a < 1')).toBe(3)                                  // 未开元素的 < 是正文
    expect(measured('正文<p')).toBe(4)                                 // 未闭合的标签把后面的文本当标签
    expect(measured('正文<!-- 未闭合')).toBe(2)                         // 未闭合的注释吞到文末
    expect(measured('正文<!doctype')).toBe(2)                           // 未闭合的声明也是标记
    expect(measured('正文</style>尾')).toBe(3)                          // 孤立的闭合标签不吞内容
    expect(measured('<p>x</p><script>var a=1')).toBe(1)                // 未闭合的 script 吞到文末
    expect(measured('<p>A&amp;B</p>')).toBe(3)                         // 命名字符引用
    expect(measured('<p>&#65;&#x42;</p>')).toBe(2)                     // 十进制与十六进制字符引用
    expect(measured('<p>&#0;&bogus;</p>')).toBe(11)                    // 越界码点与未知名按原样计
  })

  it('caps each check independently', () => {
    const text = `${Array.from({ length: 6 }, () => '{{slot}}').join('\n\n')}\n\n${Array.from({ length: 6 }, () => '## 空').join('\n\n')}\n`
    const findings = checkDocumentText(text)
    expect(findings.filter(finding => finding.check === 'placeholder')).toHaveLength(6)
    expect(findings.filter(finding => finding.check === 'empty_section')).toHaveLength(6)
    expect(findings.at(-1)?.detail).toBe('另有 1 处同类问题未逐条列出')
  })

  it('takes the summary line level from the dropped findings', () => {
    // 6 条 warn 禁用词之后还有一条 block 级禁用词：汇总行必须仍是 block，否则门禁被绕过。
    const words = style([
      ...Array.from({ length: 6 }, (_, i) => ({ word: `warn${String(i)}`, replace: 'x', severity: 'warn' as const })),
      { word: 'blocked', replace: 'y', severity: 'block' as const },
    ])
    const text = `${Array.from({ length: 6 }, (_, i) => `warn${String(i)}`).join(' ')} blocked\n`
    const findings = checkDocumentText(text, { style: words })
    expect(findings.filter(finding => finding.check === 'anti_pattern')).toHaveLength(6)
    expect(findings.at(-1)?.level).toBe('block')
    // 反向：被丢弃的都是只上报的草稿（围栏内占位符）时，汇总行不得升级为 block。
    const fenced = `${Array.from({ length: 6 }, (_, i) => `\`\`\`\n{{slot${String(i)}}}\n\`\`\``).join('\n')}\n`
    expect(checkDocumentText(fenced).filter(finding => finding.level === 'block')).toEqual([])
  })

  it('reports a placeholder quoted in inline code instead of blocking it', () => {
    // 复述检查规则的交付文档正文本身就带这些串，行内代码是它在谈论这些串的写法。
    const quoted = '- [ ] 无占位残留：无 `Lorem ipsum`、无 `[TBD]` / `{{变量}}` / 空槽\n'
    expect(checkDocumentText(quoted)).toEqual([
      { check: 'placeholder', level: 'warn', detail: '第 1 行仍有残余占位符 "{{变量}}"', line: 1 },
      { check: 'placeholder', level: 'warn', detail: '第 1 行仍有残余占位符 "[TBD]"', line: 1 },
      { check: 'placeholder', level: 'warn', detail: '第 1 行仍有残余占位符 "Lorem ipsum"', line: 1 },
    ])
    // 引号里提及仍按残余占位符处理：豁免只给代码跨度，不给"引号引用"。
    expect(checkDocumentText('- 无 "Lorem ipsum" 之类占位\n').filter(finding => finding.level === 'block')).toHaveLength(1)
    expect(checkDocumentText('- 客户名称：{{client_name}}\n').filter(finding => finding.level === 'block')).toHaveLength(1)
    expect(checkDocumentText('- 未填的 `` `{{x}}` `` 与 `{{y}}` 都要替换\n').filter(finding => finding.level === 'block')).toEqual([])
  })

  it('residual empty implies zero placeholder gate hits (cross-check)', () => {
    const cases = [
      '机构：示例代理所\n',
      '编号：2024-001\n',
      '标题：报告\n',
    ]
    for (const text of cases) {
      expect(extractPlaceholders(text)).toEqual([])
      expect(checkDocumentText(text).filter(f => f.check === 'placeholder')).toEqual([])
    }
  })

  it('the gate blocks exactly the brace forms the fill side can name (cross-package)', () => {
    // 门禁判 block 的集合必须是"填得掉"的子集，否则调用方过不了门禁也无从修改。
    const text = '{{client_name}} 与 {{客户名称}}、{{ case_id }}、{{a b}}'
    const names = extractPlaceholders(text)
    expect(names).toEqual(['client_name', '客户名称', 'case_id', 'a b'])
    expect(checkDocumentText(text).filter(finding => finding.level === 'block')).toHaveLength(4)
    const filled = substitutePlaceholders(text, Object.fromEntries(names.map(name => [name, '已填'])))
    expect(checkDocumentText(filled).filter(finding => finding.check === 'placeholder' && finding.level === 'block')).toEqual([])
  })

  it('every placeholder the gate blocks is one a variable removes (cross-package)', () => {
    // 门禁判 block 的串必须落在"可用变量修复"的集合里，否则调用方既过不了门禁、也无从修。
    const root = templatesDirectory()
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    for (const entry of files) {
      const path = join(entry.parentPath, entry.name)
      const body = readFileSync(path, 'utf8')
      const blocked = checkDocumentText(body).filter(finding => finding.check === 'placeholder' && finding.level === 'block')
      expect(blocked.length, path).toBeGreaterThan(0)
      const names = extractPlaceholders(body)
      const filled = substitutePlaceholders(body, Object.fromEntries(names.map(name => [name, '已填'])))
      expect(checkDocumentText(filled).filter(finding => finding.check === 'placeholder' && finding.level === 'block'), path).toEqual([])
    }
  })
})
