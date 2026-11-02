/**
 * 空节折叠与章节重编号（P0-01）。
 *
 * 两条纪律在此钉住：草案没给内容的可选节不得在成品里留下空标题；折叠后章节序号
 * 必须连续——`checkDocumentCompliance` 只查重复与乱序、不查缺号，缺号只能靠重编号
 * 消除，测试也因此要断言「不重编号就会断号」，而不是只断言最终结果好看。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TemplateDraft, TemplateDraftSection } from '@deepseek-ai/dsh-patent-core'
import { renderPatentDocument } from '@deepseek-ai/dsh-patent-document'
import { foldEmptyOptionalSections, renumberSections } from '../src/document/sectionFold.ts'
import { GENERIC_TEMPLATE_SCHEMAS, type TemplateSlotRegistry } from '../src/document/draftSchema/index.ts'
import { unusedSubprocess } from './helpers.ts'

const OA_SCHEMA = GENERIC_TEMPLATE_SCHEMAS['oa-response']

/** 文档里的标题文本，按出现顺序。 */
function headingTexts(html: string): string[] {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map(match => (match[2] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
}

/** 指定层级的标题文本。 */
function headingsAt(html: string, level: number): string[] {
  return [...html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'g'))]
    .map(match => (match[1] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
}

/** 只填必填槽位的草案：可选槽位一律缺席，用来触发折叠。 */
function requiredDraft(schema: TemplateSlotRegistry): TemplateDraft {
  const fields: Record<string, string> = {}
  for (const [id, slot] of Object.entries(schema.fields ?? {})) {
    if (slot.required === true) fields[id] = `填${id}`
  }
  const sections: TemplateDraftSection[] = []
  for (const [id, slot] of Object.entries(schema.sections)) {
    if (slot.required !== true) continue
    sections.push(slot.kind === 'rows'
      ? { id, rows: [Array.from({ length: slot.columns }, (_, index) => `格${index + 1}`)] }
      : { id, blocks: [{ kind: 'paragraph', text: `正文${id}` }] })
  }
  return { fields, sections }
}

/** 渲染一份 oa-response 草案并读回成品与告警。 */
async function renderOa(draft: TemplateDraft): Promise<{ html: string; warnings: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-section-fold-'))
  try {
    const result = await renderPatentDocument(
      { template: 'oa-response', outputName: 'folded', outputDir: dir, format: 'html', templateDraft: draft },
      dir,
      { subprocess: unusedSubprocess() },
    )
    return { html: readFileSync(result.htmlPath, 'utf8'), warnings: result.warnings }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('foldEmptyOptionalSections', () => {
  const block = '<div data-omit-if-empty="x"><h3>5.3 其他争点</h3><div id="x"></div></div>'

  it('槽位有内容时原样保留', () => {
    const result = foldEmptyOptionalSections(`<section>${block}</section>`, new Set(['x']))
    expect(result.html).toBe(`<section>${block}</section>`)
    expect(result.folded).toEqual([])
  })

  it('槽位缺席时整块移除，标题取自块内第一个标题', () => {
    const result = foldEmptyOptionalSections(`<section>${block}</section>`, new Set())
    expect(result.html).toBe('<section></section>')
    expect(result.folded).toEqual([{ id: 'x', title: '5.3 其他争点' }])
  })

  it('块内没有标题时以槽位 id 报出', () => {
    const result = foldEmptyOptionalSections('<div data-omit-if-empty="y"></div>', new Set())
    expect(result.folded).toEqual([{ id: 'y', title: 'y' }])
  })

  it('移除块时连同整行缩进与行尾换行一起去掉（行首无缩进时只去元素）', () => {
    const indented = foldEmptyOptionalSections(`<section>\n  ${block}\n  <p>保留</p>\n</section>`, new Set())
    expect(indented.html).toBe('<section>\n  <p>保留</p>\n</section>')
    const flush = foldEmptyOptionalSections(`${block}<p>保留</p>`, new Set())
    expect(flush.html).toBe('<p>保留</p>')
  })

  it('标记元素没有配对闭合标签时原样保留（不猜边界）', () => {
    const html = '<section><div data-omit-if-empty="z"><p>正文</p>'
    const result = foldEmptyOptionalSections(html, new Set())
    expect(result.html).toBe(html)
    expect(result.folded).toEqual([])
  })

  it('标记元素的闭合标签不是同名标签时报错（模板被手改）', () => {
    expect(() => foldEmptyOptionalSections('<div data-omit-if-empty="z"></span>', new Set())).toThrow(/闭合标签却不是/)
    expect(() => foldEmptyOptionalSections('<div data-omit-if-empty="z"><p>正文</p></section>', new Set()))
      .toThrow(/闭合标签却不是/)
  })
})

describe('renumberSections', () => {
  it('没有中文序号章节的文书原样返回', () => {
    const html = '<h2>摘要</h2><h3>1.1 小节</h3>'
    expect(renumberSections(html)).toBe(html)
  })

  it('折叠出缺号后按出现顺序重编，并改写小节前缀', () => {
    const html = [
      '<h2>一、总体立场</h2>',
      '<h2>二、本次修改</h2>',
      '<h3>2.1 修改后的独立权利要求</h3>',
      '<h2>三、本案事实</h2>',
      '<h2>四、适用规则</h2>',
      '<h2>五、意见陈述</h2>',
      '<h2>七、证据与引用</h2>',
      '<h3>7.1 证据清单</h3>',
      '<h3>7.2 引用日志</h3>',
      '<h2>八、结论与请求</h2>',
    ].join('\n')
    expect(renumberSections(html)).toBe([
      '<h2>一、总体立场</h2>',
      '<h2>二、本次修改</h2>',
      '<h3>2.1 修改后的独立权利要求</h3>',
      '<h2>三、本案事实</h2>',
      '<h2>四、适用规则</h2>',
      '<h2>五、意见陈述</h2>',
      '<h2>六、证据与引用</h2>',
      '<h3>6.1 证据清单</h3>',
      '<h3>6.2 引用日志</h3>',
      '<h2>七、结论与请求</h2>',
    ].join('\n'))
  })

  it('不带序号的分区标题与无对应章节的小节前缀都不动', () => {
    const html = [
      '<h2>一、概况</h2>',
      '<h2>附页</h2>',
      '<h3>9.1 无对应章节</h3>',
      '<h2>三、收尾</h2>',
      '<h3>3.1.1 三级编号只换节号</h3>',
    ].join('\n')
    expect(renumberSections(html)).toBe([
      '<h2>一、概况</h2>',
      '<h2>附页</h2>',
      '<h3>9.1 无对应章节</h3>',
      '<h2>二、收尾</h2>',
      '<h3>2.1.1 三级编号只换节号</h3>',
    ].join('\n'))
  })

  it('保留标题标签上的属性与缩进', () => {
    const html = '<h2 class="chapter">一、概况</h2>\n  <h2>三、收尾</h2>'
    expect(renumberSections(html)).toBe('<h2 class="chapter">一、概况</h2>\n  <h2>二、收尾</h2>')
  })
})

describe('oa-response 成品折叠与重编号（P0-01）', () => {
  it('两个可选节都缺席：成品无六、无 5.3，其余章节连号', async () => {
    const { html, warnings } = await renderOa(requiredDraft(OA_SCHEMA))
    expect(headingsAt(html, 2)).toEqual([
      '一、总体立场', '二、本次修改', '三、本案事实', '四、适用规则', '五、意见陈述', '六、证据与引用', '七、结论与请求',
    ])
    expect(headingsAt(html, 3)).toEqual([
      '2.1 修改后的独立权利要求', '3.1 申请文件记载的事实', '3.2 对比文件公开的事实',
      '5.1 关于新颖性', '5.2 关于创造性', '6.1 证据清单', '6.2 引用日志',
    ])
    expect(warnings.filter(warning => warning.includes('已折叠空节'))).toEqual([
      '已折叠空节：5.3 其他争点（槽位 argument-other 无内容）',
      '已折叠空节：六、其他缺陷的处理（槽位 formalities-body 无内容）',
    ])
  })

  it('负控制：同一份成品若不重编号，章节号会断在「五、」与「七、」之间', () => {
    // 直接对折叠结果做断言，钉住 renumberSections 的必要性：合规检查不查缺号，缺号不会自曝。
    const html = [
      '<h2>一、总体立场</h2>',
      '<h2>五、意见陈述</h2>',
      '<section data-omit-if-empty="formalities-body"><h2>六、其他缺陷的处理</h2><div id="formalities-body"></div></section>',
      '<h2>七、证据与引用</h2>',
    ].join('\n')
    const folded = foldEmptyOptionalSections(html, new Set())
    expect(headingsAt(folded.html, 2)).toEqual(['一、总体立场', '五、意见陈述', '七、证据与引用'])
    expect(headingsAt(renumberSections(folded.html), 2)).toEqual(['一、总体立场', '二、意见陈述', '三、证据与引用'])
  })

  it('有形式缺陷时整节保留，编号不变，只有 5.3 被折叠', async () => {
    const draft = requiredDraft(OA_SCHEMA)
    draft.sections.push({ id: 'formalities-body', blocks: [{ kind: 'paragraph', text: '审查意见第 2 项：同意修改摘要。' }] })
    const { html, warnings } = await renderOa(draft)
    expect(headingsAt(html, 2)).toEqual([
      '一、总体立场', '二、本次修改', '三、本案事实', '四、适用规则', '五、意见陈述', '六、其他缺陷的处理', '七、证据与引用', '八、结论与请求',
    ])
    expect(headingsAt(html, 3)).toContain('7.1 证据清单')
    expect(headingsAt(html, 3)).not.toContain('5.3 其他争点')
    expect(warnings.filter(warning => warning.includes('已折叠空节'))).toEqual([
      '已折叠空节：5.3 其他争点（槽位 argument-other 无内容）',
    ])
  })

  it('两个可选节都有内容时零折叠、零告警，编号一字不动', async () => {
    const draft = requiredDraft(OA_SCHEMA)
    draft.sections.push({ id: 'argument-other', blocks: [{ kind: 'paragraph', text: '关于 26.4 的支持问题。' }] })
    draft.sections.push({ id: 'formalities-body', blocks: [{ kind: 'paragraph', text: '审查意见第 2 项：同意修改摘要。' }] })
    const { html, warnings } = await renderOa(draft)
    expect(headingsAt(html, 2)).toHaveLength(8)
    expect(headingTexts(html)).toContain('5.3 其他争点')
    expect(warnings.filter(warning => warning.includes('已折叠空节'))).toEqual([])
  })
})
