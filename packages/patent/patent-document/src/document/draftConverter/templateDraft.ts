/**
 * src/document/draftConverter/templateDraft — 表单模板草案 → 模板 HTML 注入。
 *
 * 与 injectSections（元素 id → innerHTML）不同，表单模板的槽位是 data-slot 属性：
 * text 槽填充 `.fill` 文本（同一 id 多处出现则全部填充同一值，如页脚页码）；
 * choice 槽按 `data-slot="<组>:<选项>"` 给命中的 `.cb` 加 `on` 类渲染勾选；
 * blocks 槽以首个命中元素为行包装（取其内部唯一 `.fill` 为文本载体），每个
 * 正文块克隆一行，其余同名空占位元素移除；rows 槽以 `<tr data-slot>` 为行模板，
 * 按草案行数克隆并按列序填充单元格。纯展示元素无 data-slot，天然不被触碰。
 * @module @deepseek-ai/dsh-patent-document/document/draftConverter/templateDraft
 */

import type { DraftBlock, TemplateDraft } from '@deepseek-ai/dsh-patent-core'
import { DocumentRenderError } from '../errors.ts'
import { findMatchingCloseTag } from '../htmlScan.ts'
import { FORM_TEMPLATE_SCHEMAS, type FormTemplateId } from '../draftSchema/index.ts'
import { escapeHtmlText } from './escape.ts'

/** data-slot 属性值的正则安全形式（注册表与模板锁定的受限字符集）。 */
function slotPattern(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** findSlotElement 的命中信息。 */
interface SlotElementHit {
  /** 开标签起始下标。 */
  start: number
  /** 完整开标签文本。 */
  openTag: string
  /** 元素标签名。 */
  name: string
  /** 内容起始下标。 */
  contentStart: number
  /** 配对闭合标签起始下标。 */
  closeStart: number
  /** 闭合标签结束下标（元素整体结束）。 */
  end: number
}

/**
 * 找到 HTML 中首个携带指定 data-slot 的元素，返回开标签文本、内容区间与闭合位置。
 * @returns 命中信息；未命中返回 undefined。
 */
function findSlotElement(html: string, slotRef: string): SlotElementHit | undefined {
  const openRe = new RegExp(`<([A-Za-z][A-Za-z0-9]*)((?:(?!data-slot=)[^>])*)data-slot="${slotPattern(slotRef)}"((?:(?!data-slot=)[^>])*)>`, 'i')
  const match = openRe.exec(html)
  if (match === null) return undefined
  const openTag = match[0]
  const start = match.index
  const contentStart = start + openTag.length
  const closeStart = findMatchingCloseTag(html, contentStart)
  if (closeStart === undefined) return undefined
  return {
    start,
    openTag,
    name: match[1] as string,
    contentStart,
    closeStart,
    // findMatchingCloseTag 的合同保证 closeStart 处即配对闭合标签起始。
    end: closeStart + html.slice(closeStart).indexOf('>') + 1,
  }
}

/** 去掉开标签上的 data-slot 属性（克隆行不再携带槽位标记）。 */
function stripSlotAttr(openTag: string): string {
  return openTag.replace(/\s*data-slot="[^"]*"/, '')
}

/** 填充 text 槽：所有 `data-slot=id` 的元素内容设置为转义后的值（填充时即剥离槽位标记）。 */
function injectTextSlot(html: string, id: string, value: string): string {
  const escaped = escapeHtmlText(value)
  let result = html
  for (let guard = 0; guard < 100; guard += 1) {
    const hit = findSlotElement(result, id)
    if (hit === undefined) break
    result = result.slice(0, hit.start) + stripSlotAttr(hit.openTag) + escaped + result.slice(hit.closeStart)
  }
  return result
}

/** 勾选 choice 选项：给 `data-slot=<组>:<选项>` 的 .cb 加 on 类；模板缺选项时报错。 */
function checkChoiceOption(html: string, groupId: string, optionId: string): string {
  const ref = `${groupId}:${optionId}`
  const cbRe = new RegExp(`<span class="cb"(?![^>]*\\bon\\b)((?:(?!data-slot=)[^>])*)data-slot="${slotPattern(ref)}"((?:(?!data-slot=)[^>])*)>`)
  if (!cbRe.test(html)) {
    throw new DocumentRenderError(`模板缺少选项复选框 data-slot="${ref}"（注册表与模板资产不一致）`)
  }
  return html.replace(cbRe, '<span class="cb on"$1data-slot="' + ref + '"$2>')
}

/** 提取元素内容里的唯一 .fill 载体开标签；缺失时报错。 */
function requireFillCarrier(inner: string, slotId: string): string {
  const fillMatch = /<span class="fill[^"]*"[^>]*>/.exec(inner)
  if (fillMatch === null) {
    throw new DocumentRenderError(`槽位 ${slotId} 的模板元素缺少 .fill 文本载体`)
  }
  return fillMatch[0]
}

/** 把一个正文块渲染为行包装克隆：paragraph 一行，list 每项一行。 */
function renderBlockLine(wrapperOpen: string, wrapperClose: string, fillOpen: string, block: DraftBlock): string {
  if (block.kind === 'table') {
    throw new DocumentRenderError('表单模板不支持表格块（校验器应在到达转换器前拒绝）')
  }
  const texts = block.kind === 'list' ? block.items : [block.text]
  return texts.map(text => `${wrapperOpen}${fillOpen}${escapeHtmlText(text)}</span>${wrapperClose}`).join('')
}

/** 注入 blocks 章节槽：首个命中元素为行包装，逐块克隆；其余同名占位元素移除。 */
function injectBlocksSlot(html: string, slotId: string, blocks: readonly DraftBlock[]): string {
  const first = findSlotElement(html, slotId)
  if (first === undefined) {
    throw new DocumentRenderError(`模板缺少章节槽位 data-slot="${slotId}"`)
  }
  const inner = html.slice(first.contentStart, first.closeStart)
  const fillOpen = requireFillCarrier(inner, slotId)
  const wrapperOpen = stripSlotAttr(first.openTag)
  const wrapperClose = `</${first.name}>`
  const lines = blocks.map(block => renderBlockLine(wrapperOpen, wrapperClose, fillOpen, block)).join('')
  let result = html.slice(0, first.start) + lines + html.slice(first.end)
  // 移除其余同名空占位元素（连同所在行的缩进一并吞掉，不留空白尾巴）。
  for (let guard = 0; guard < 100; guard += 1) {
    const extra = findSlotElement(result, slotId)
    if (extra === undefined) break
    let start = result.indexOf(extra.openTag)
    let lineStart = start
    while (lineStart > 0 && (result[lineStart - 1] === ' ' || result[lineStart - 1] === '\t')) {
      lineStart -= 1
    }
    if (lineStart > 0 && result[lineStart - 1] === '\n') start = lineStart
    result = result.slice(0, start) + result.slice(extra.end)
  }
  return result
}

/** 用一行的单元格值填充行模板（依次填入模板中的空 .fill）。 */
function fillRowTemplate(rowTemplate: string, cells: readonly string[]): string {
  let index = 0
  return rowTemplate.replace(/(<span class="fill[^"]*"[^>]*>)<\/span>/g, (_match, open: string) => {
    const cell = cells[index] as string
    index += 1
    return `${open}${escapeHtmlText(cell)}</span>`
  })
}

/** 注入 rows 章节槽：`<tr data-slot=id>` 为行模板，按草案行数克隆。 */
function injectRowsSlot(html: string, slotId: string, rows: readonly (readonly string[])[]): string {
  const hit = findSlotElement(html, slotId)
  if (hit === undefined) {
    throw new DocumentRenderError(`模板缺少数据行槽位 data-slot="${slotId}"`)
  }
  const inner = html.slice(hit.contentStart, hit.closeStart)
  const fillCount = (inner.match(/<span class="fill[^"]*"[^>]*><\/span>/g) ?? []).length
  if (fillCount === 0) {
    throw new DocumentRenderError(`数据行槽位 ${slotId} 的模板行缺少 .fill 单元格`)
  }
  const rowOpen = stripSlotAttr(hit.openTag)
  const rowTemplate = `${rowOpen}${inner}</${hit.name}>`
  const rendered = rows.map((cells) => {
    if (cells.length !== fillCount) {
      throw new DocumentRenderError(`数据行槽位 ${slotId} 列数 ${cells.length} 与模板列数 ${fillCount} 不一致`)
    }
    return fillRowTemplate(rowTemplate, cells)
  }).join('')
  const start = hit.start
  return html.slice(0, start) + rendered + html.slice(hit.end)
}

/**
 * 把表单模板受控草案注入模板 HTML。
 * @param html - 模板 HTML（已做品牌注入）。
 * @param template - 表单模板 id。
 * @param draft - 已通过 validateTemplateDraft（注册表 schema）校验的草案。
 * @returns 注入后的 HTML。
 */
export function injectTemplateDraft(html: string, template: FormTemplateId, draft: TemplateDraft): string {
  const schema = FORM_TEMPLATE_SCHEMAS[template]
  let result = html
  for (const [id, value] of Object.entries(draft.fields ?? {})) {
    const slot = schema.fields?.[id]
    if (slot?.kind === 'choice') {
      const selected = Array.isArray(value) ? value : [value]
      for (const optionId of selected) {
        result = checkChoiceOption(result, id, optionId)
      }
      continue
    }
    if (Array.isArray(value)) {
      throw new DocumentRenderError(`槽位 ${id} 不是多选 choice 槽位，不接受数组`)
    }
    result = injectTextSlot(result, id, value)
  }
  for (const section of draft.sections) {
    if (section.blocks !== undefined) {
      result = injectBlocksSlot(result, section.id, section.blocks)
    } else if (section.rows !== undefined) {
      result = injectRowsSlot(result, section.id, section.rows)
    } else {
      // 表单模板没有 grounds 槽位（该槽位只登记在通用文档模板的注册表里），校验器应当先拒绝。
      throw new DocumentRenderError(`表单模板不支持无效理由节（槽位 ${section.id} 应为 blocks 或 rows）`)
    }
  }
  // 注入是一次性操作：成品不携带槽位机器，全部剥掉 data-slot 属性。
  return result.replace(/\s*data-slot="[^"]*"/g, '')
}
