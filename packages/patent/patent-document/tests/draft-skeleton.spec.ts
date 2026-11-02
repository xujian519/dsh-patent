// 草案模板的骨架契约。模板既是体例来源，也是模型内容的容器：
// 1) 可选槽位的骨架必须为空——省略它时，撰写期提示语/占位值不得出现在成品里；
// 2) 槽位元素内部不得含标题——填报一个 blocks 槽位只能替换自己的容器，不能连分区标题一起吞掉
//    （否则章节编号断号，例如填了「二、分析依据与判断标准」的槽位后编号从一直接跳到三）；
// 3) 只填必填槽位的最小草案渲染后，模板里的标题必须全部还在成品里；
// 4) 该成品不得出现模板伪造的编号占位——抬头/页脚的编号由草案供给，骨架不得自带看似真的值。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DocumentTemplateId } from '../src/document/types.ts'
import type {
  SpecDraft,
  TemplateDraft,
  TemplateDraftSection,
  TemplateFieldSlot,
  TemplateSectionSlot,
} from '@deepseek-ai/dsh-patent-core'
import { renderPatentDocument } from '@deepseek-ai/dsh-patent-document'
import { findMatchingCloseTag } from '../src/document/htmlScan.ts'
import { foldEmptyOptionalSections, renumberSections } from '../src/document/sectionFold.ts'
import { readTemplateHtml } from '../src/document/templateResolver.ts'
import {
  FORM_TEMPLATE_IDS,
  FORM_TEMPLATE_SCHEMAS,
  GENERIC_TEMPLATE_IDS,
  GENERIC_TEMPLATE_SCHEMAS,
  type TemplateSlotRegistry,
} from '../src/document/draftSchema/index.ts'
import { unusedSubprocess } from './helpers.ts'

/** 槽位引用（元素 id 或 data-slot 组名）在模板中的出现形态。 */
type SlotAttribute = 'id' | 'data-slot'

/** 全部走 TemplateDraft 的模板及其槽位机制。 */
const DRAFT_TEMPLATES: ReadonlyArray<{ id: DocumentTemplateId; schema: TemplateSlotRegistry; attribute: SlotAttribute }> = [
  ...GENERIC_TEMPLATE_IDS.map(id => ({ id, schema: GENERIC_TEMPLATE_SCHEMAS[id], attribute: 'id' as const })),
  ...FORM_TEMPLATE_IDS.map(id => ({ id, schema: FORM_TEMPLATE_SCHEMAS[id], attribute: 'data-slot' as const })),
]

/** 注册表里的全部槽位：`槽位引用 → 槽位声明`。 */
function slotEntries(schema: TemplateSlotRegistry): Array<[string, TemplateFieldSlot | TemplateSectionSlot]> {
  return [...Object.entries(schema.fields ?? {}), ...Object.entries(schema.sections ?? {})]
}

/** 注册表里的全部槽位引用（元素 id 或 data-slot 组名）。 */
function slotRefs(schema: TemplateSlotRegistry): string[] {
  return slotEntries(schema).map(([ref]) => ref)
}

/** 槽位引用在 HTML 中的正则安全形式。 */
function escapeRef(ref: string): string {
  return ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 槽位元素：开标签、innerHTML 与在文档中的起始位置。 */
interface SlotElement {
  /** 完整开标签。 */
  openTag: string
  /** 元素内容。 */
  inner: string
  /** 开标签起始下标。 */
  start: number
}

/** 定位槽位元素；未命中返回 undefined。choice 组按 `组:选项` 形态一并命中。 */
function slotElement(html: string, ref: string, attribute: SlotAttribute): SlotElement | undefined {
  const pattern = new RegExp(`<[A-Za-z][A-Za-z0-9]*[^>]*\\b${attribute}="${escapeRef(ref)}(?::[^"]*)?"[^>]*>`)
  const match = pattern.exec(html)
  if (match === null) return undefined
  const openEnd = match.index + match[0].length
  const closeStart = findMatchingCloseTag(html, openEnd)
  return {
    openTag: match[0],
    inner: closeStart === undefined ? '' : html.slice(openEnd, closeStart),
    start: match.index,
  }
}

/** 判断槽位是否只是文档里的装饰：签名行（`class="sign-block"`）有意留白，姓名与日期由人工签署时填写。 */
function isSignatureLine(element: SlotElement): boolean {
  return /class="[^"]*\bsign-block\b/.test(element.openTag)
}

/** 按渲染管线折叠可空节（最小草案只填必填槽位）并重编号后的模板：标题期望的来源。 */
function foldedTemplateHtml(html: string, schema: TemplateSlotRegistry): string {
  const present = new Set(Object.entries(schema.sections)
    .filter(([, slot]) => slot.required === true)
    .map(([id]) => id))
  const folded = foldEmptyOptionalSections(html, present)
  return folded.folded.length === 0 ? folded.html : renumberSections(folded.html)
}

/** 模板里静态标题（标题文字不含子槽位）的可见文本；由子槽位拼出的标题随草案变化，不参与比较。 */
function staticHeadingTexts(html: string, refs: readonly string[], attribute: SlotAttribute): string[] {
  const slots = refs
    .map(ref => slotElement(html, ref, attribute))
    .filter((element): element is SlotElement => element !== undefined)
  return headingTags(html)
    .filter((match) => {
      const start = match.index ?? 0
      const end = start + match[0].length
      return !slots.some(element => element.start > start && element.start < end)
    })
    .map(match => visibleText(match[1] ?? ''))
}

/** 文档里的全部标题标签（含标签与标题文字）。 */
function headingTags(html: string): RegExpMatchArray[] {
  return [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)]
}

/** 去掉标签与常见实体后的可见文本。 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 模板伪造的编号占位（如 `CS-2026-XXXX`）：连续 3 个以上大写 X。 */
const FABRICATED_PLACEHOLDER = /X{3,}/

/** 文档里全部标题的可见文本，按出现顺序。 */
function headingTexts(html: string): string[] {
  return headingTags(html).map(match => visibleText(match[1] ?? ''))
}

/** 只填必填槽位的最小草案：可选槽位一律省略，用来暴露骨架泄漏。 */
function minimalDraft(schema: TemplateSlotRegistry): TemplateDraft {
  const fields: Record<string, string | string[]> = {}
  for (const [id, slot] of Object.entries(schema.fields ?? {})) {
    if (slot.required !== true) continue
    if (slot.kind === 'choice') {
      const first = slot.options?.[0]?.id ?? ''
      fields[id] = slot.multiple === true ? [first] : first
    } else {
      fields[id] = `填${id}`
    }
  }
  const sections: TemplateDraftSection[] = []
  for (const [id, slot] of Object.entries(schema.sections ?? {})) {
    if (slot.required !== true) continue
    sections.push(slot.kind === 'rows'
      ? { id, rows: [Array.from({ length: slot.columns ?? 1 }, (_, index) => `格${index + 1}`)] }
      : { id, blocks: [{ kind: 'paragraph', text: `正文${id}` }] })
  }
  return { fields, sections }
}

/** 最小 claims-spec 草案：附图说明一条列表项对应一幅附图。 */
function minimalSpecDraft(): SpecDraft {
  return {
    meta: { caseNumber: 'CN2026-0001', title: '骨架标题', applicant: '申请人', inventor: '发明人', agent: '代理机构', date: '2026-10-09' },
    claims: ['一种装置。'],
    abstract: ['本发明公开一种装置。'],
    figureFiles: ['fig1.png'],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '技术领域正文。' }],
      background: [{ kind: 'paragraph', text: '背景技术正文。' }],
      summary: [{ kind: 'paragraph', text: '发明内容正文。' }],
      drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
      embodiment: [{ kind: 'paragraph', text: '具体实施方式正文。' }],
    },
  }
}

/** 渲染一个模板并读回成品 HTML。 */
async function renderTemplate(
  template: DocumentTemplateId,
  draft: { draft: SpecDraft } | { templateDraft: TemplateDraft },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doc-skeleton-'))
  try {
    const result = await renderPatentDocument(
      { template, outputName: 'skeleton', outputDir: dir, format: 'html', ...draft },
      dir,
      { subprocess: unusedSubprocess() },
    )
    return readFileSync(result.htmlPath, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('草案模板骨架契约', () => {
  for (const { id, schema, attribute } of DRAFT_TEMPLATES) {
    describe(id, () => {
      const html = readTemplateHtml(id)

      it('可选槽位的骨架为空（签名行除外）', () => {
        const offenders: string[] = []
        for (const [ref, slot] of slotEntries(schema)) {
          if (slot.required === true) continue
          const element = slotElement(html, ref, attribute)
          if (element === undefined || isSignatureLine(element)) continue
          const text = visibleText(element.inner)
          if (text !== '') offenders.push(`${ref}：${text}`)
        }
        expect(offenders).toEqual([])
      })

      it('槽位元素内不含标题', () => {
        const offenders = slotRefs(schema).filter((ref) => {
          const element = slotElement(html, ref, attribute)
          return element !== undefined && /<h[1-6][\s>]/i.test(element.inner)
        })
        expect(offenders).toEqual([])
      })

      it('最小草案渲染后模板标题全部保留，且无伪造编号占位', async () => {
        const output = await renderTemplate(id, { templateDraft: minimalDraft(schema) })
        const actual = headingTexts(output)
        // 期望取自「折叠 + 重编号后的模板」：可空节随最小草案消失，其后章节号前移。
        const expected = staticHeadingTexts(foldedTemplateHtml(html, schema), slotRefs(schema), attribute)
        expect(expected.filter(text => !actual.includes(text))).toEqual([])
        expect(visibleText(output).match(FABRICATED_PLACEHOLDER)).toBeNull()
      })
    })
  }

  it('oa-response 最小草案渲染后不残留签署栏占位下划线', async () => {
    const output = await renderTemplate('oa-response', {
      templateDraft: minimalDraft(GENERIC_TEMPLATE_SCHEMAS['oa-response']),
    })
    expect(output).not.toContain('________')
    expect(output).toContain('<div class="sign-block">代理人：</div>')
    expect(output).toContain('<div class="sign-block">日期：</div>')
  })

  it('claims-spec 最小草案渲染后模板标题全部保留，且无伪造编号占位', async () => {
    const output = await renderTemplate('claims-spec', { draft: minimalSpecDraft() })
    const actual = headingTexts(output)
    // claims-spec 无槽位注册表：骨架标题全部计入比较（abstract 槽里的「摘要」小节标题由转换器重建）。
    expect(headingTexts(readTemplateHtml('claims-spec')).filter(text => !actual.includes(text))).toEqual([])
    expect(visibleText(output).match(FABRICATED_PLACEHOLDER)).toBeNull()
    // 案卷号由草案供给：抬头编号行与页脚都印草案的值。
    expect(output).toContain('案卷号：<span class="mono" id="meta-case">CN2026-0001</span> · 版本 V1.0')
    expect(output).toContain('<span id="footer-case">CN2026-0001</span>')
  })
})
