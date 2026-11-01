/**
 * src/document/draftSchema — 受控草案注册表（表单模板 + 通用文档模板）。
 *
 * 表单模板（data-slot 机制）的槽位集合以 `references/slots.md` 为事实源手工登记；
 * 通用文档模板（元素 id 机制）的槽位由 draft-schema-conformance 测试对照
 * template.html 机械提取结果双向锁定。纯展示元素在 staticElements 逐条记录理由。
 * @module @deepseek-ai/dsh-patent-document/document/draftSchema
 */

import type { TemplateDraftSchema, TemplateSectionSlot } from '@deepseek-ai/dsh-patent-core'
import type { DocumentTemplateId } from '../types.ts'
import { isGenericTemplateId } from './generic.ts'

/** 已接入受控草案的表单模板 id。 */
export const FORM_TEMPLATE_IDS = ['right-evaluation-report', 'search-report-form'] as const

/** 表单模板 id。 */
export type FormTemplateId = (typeof FORM_TEMPLATE_IDS)[number]

/** 判断模板 id 是否已接入 TemplateDraft 草案模型。
 * @param id - 模板 id。
 * @returns 该 id 是否为表单模板 id（类型守卫）。
 */
export function isFormTemplateId(id: DocumentTemplateId): id is FormTemplateId {
  return (FORM_TEMPLATE_IDS as readonly string[]).includes(id)
}

/** 模板草案注册表项：槽位 schema + 纯展示元素登记（表单与通用文档模板共用）。 */
export interface TemplateSlotRegistry extends TemplateDraftSchema {
  /**
   * 章节槽位表。声明为必填（`TemplateDraftSchema` 里可选）：两个机制下的注册表都逐条登记章节槽位，
   * 没有空 `sections` 的形态，因此取体例的代码不必为「注册表没写 sections」兜底。
   */
  sections: Record<string, TemplateSectionSlot>
  /** 模板中无槽位的纯展示元素，逐条给出不设槽位的理由（marker 为模板中的可检索文本）。 */
  staticElements: ReadonlyArray<{ marker: string; reason: string }>
}

const YMD = (prefix: string, required: boolean): Record<string, { required: boolean }> => ({
  [`${prefix}Year`]: { required },
  [`${prefix}Month`]: { required },
  [`${prefix}Day`]: { required },
})

/** 两表单模板共有的检索工作分区（B 检索领域 / C 数据库 / D 相关文件）。 */
const SEARCH_WORK_SECTIONS = {
  searchField: { required: true, kind: 'blocks' },
  databases: { required: true, kind: 'blocks' },
  relatedDocuments: { required: true, kind: 'rows', columns: 6 },
} as const

/** 单项勾选框 choice 槽（如「附有副本」「参见续页」）。 */
function checkboxSlot(label: string, optionId: string): { kind: 'choice'; multiple: true; options: [{ id: string; label: string }] } {
  return { kind: 'choice', multiple: true, options: [{ id: optionId, label }] }
}

/** right-evaluation-report 的草案注册表（槽位事实源：references/slots.md）。 */
const RIGHT_EVALUATION_SCHEMA: TemplateSlotRegistry = {
  fields: {
    patentNo: { required: true },
    ...YMD('applicationDate', true),
    ...YMD('priorityDate', false),
    ...YMD('grantDate', true),
    inventionTitle: { required: true },
    patentee: { required: true },
    requester: { required: true },
    ...YMD('requestDate', true),
    totalPages: { required: false },
    attachedCopies: { required: false, ...checkboxSlot('附有报告中引用的各相关文件的副本', 'attached') },
    attachedCopiesCount: { required: false },
    evalTarget: {
      required: true,
      kind: 'choice',
      options: [
        { id: 'granted', label: '与授权公告一并公布的专利文件' },
        { id: 'maintained', label: '由生效的无效宣告请求审查决定维持有效的专利文件' },
      ],
    },
    invalidDecisionNo: { required: false },
    searchScope: {
      required: true,
      kind: 'choice',
      multiple: true,
      options: [
        { id: 'all', label: '全部权利要求' },
        { id: 'art2', label: '未被检索：主题不符合专利法第 2 条第 3 款' },
        { id: 'art5_25', label: '未被检索：主题属于专利法第 5 条或第 25 条范围' },
        { id: 'utility', label: '未被检索：主题不具备实用性' },
        { id: 'enablement', label: '未被检索：说明书未清楚完整说明' },
        { id: 'other', label: '其他未被检索理由' },
      ],
    },
    allClaimsRange: { required: false },
    art2NotSearchedClaims: { required: false },
    art5NotSearchedClaims: { required: false },
    notSearchedUtilityClaims: { required: false },
    otherNotSearchedClaims: { required: false },
    otherNotSearchedReason: { required: false },
    moreDocuments: { required: false, ...checkboxSlot('相关文件，参见续页 I', 'continued') },
    ipcClass: { required: true },
    prelimConclusion: {
      required: true,
      kind: 'choice',
      options: [
        { id: 'allSound', label: '全部权利要求未发现存在不符合授予专利权条件的缺陷' },
        { id: 'allDefective', label: '全部权利要求不符合授予专利权条件' },
        { id: 'partial', label: '部分权利要求不符合，其余未发现缺陷' },
      ],
    },
    soundClaimsRange: { required: false },
    defectiveClaimsRange: { required: false },
    partialDefectiveClaims: { required: false },
    partialSoundClaims: { required: false },
    scopeConclusion: {
      required: false,
      kind: 'choice',
      multiple: true,
      options: [
        { id: 'art5', label: '权利要求属于专利法第 5 条规定的不授予专利权的范围' },
        { id: 'art25', label: '权利要求属于专利法第 25 条规定的不授予专利权的范围' },
        { id: 'art2', label: '权利要求不符合专利法第 2 条第 3 款的规定' },
        { id: 'utility224', label: '权利要求不具备专利法第 22 条第 4 款规定的实用性' },
        { id: 'spec263', label: '说明书不符合专利法第 26 条第 3 款的规定' },
      ],
    },
    art5Claims: { required: false },
    art25Claims: { required: false },
    art2SubjectClaims: { required: false },
    utilityDefectClaims: { required: false },
    noveltyConclusion: {
      required: false,
      kind: 'choice',
      multiple: true,
      options: [
        { id: 'novel', label: '权利要求具备专利法第 22 条第 2 款规定的新颖性' },
        { id: 'no', label: '权利要求不具备专利法第 22 条第 2 款规定的新颖性' },
      ],
    },
    noveltyYesClaims: { required: false },
    noveltyNoClaims: { required: false },
    inventiveConclusion: {
      required: false,
      kind: 'choice',
      multiple: true,
      options: [
        { id: 'yes', label: '权利要求具备专利法第 22 条第 3 款规定的创造性' },
        { id: 'no', label: '权利要求不具备专利法第 22 条第 3 款规定的创造性' },
      ],
    },
    inventiveYesClaims: { required: false },
    inventiveNoClaims: { required: false },
    clarityConclusion: {
      required: false,
      kind: 'choice',
      multiple: true,
      options: [
        { id: 'art264', label: '权利要求不符合专利法第 26 条第 4 款的规定' },
        { id: 'rules202', label: '权利要求不符合专利法实施细则第 20 条第 2 款的规定' },
        { id: 'art33', label: '权利要求不符合专利法第 33 条或实施细则第 43 条第 1 款的规定' },
        { id: 'art9', label: '权利要求不符合专利法第 9 条的规定' },
      ],
    },
    art264Claims: { required: false },
    rules202Claims: { required: false },
    art33Claims: { required: false },
    art9Claims: { required: false },
    moreOpinion: { required: false, ...checkboxSlot('专利权评价意见，参见续页 II', 'continued') },
    examiner: { required: false },
    reviewer: { required: false },
    ...YMD('completionDate', false),
  },
  sections: {
    ...SEARCH_WORK_SECTIONS,
    opinion: { required: true, kind: 'blocks' },
    opinionContinued: { required: false, kind: 'blocks' },
  },
  staticElements: [
    { marker: '评价所针对的文本', reason: '分区标题等文书固定文字，不由模型填写' },
    { marker: '第 ', reason: '页脚页码逐页不同，单一草案值无法表达；页码在打印/定稿时由人工或分页流程填写（与签名块人工补约定一致）' },
    { marker: '说明书不符合专利法第 26 条第 3 款的规定', reason: 'spec263 选项无配套 fill：结论针对说明书整体，不涉及权利要求项号' },
    { marker: '专利权评价报告<br>专用章', reason: '版式固有元素（专用章格）' },
    { marker: '220701', reason: '表格代码与版次号为版式固有元素' },
    { marker: '相关文件，参见续页 I', reason: '固定引导语，是否勾选由 moreDocuments 选项驱动' },
  ],
}

/** search-report-form 的草案注册表（槽位事实源：references/slots.md）。 */
const SEARCH_REPORT_SCHEMA: TemplateSlotRegistry = {
  fields: {
    reportNo: { required: true },
    ...YMD('searchDate', true),
    ...YMD('cutoffDate', false),
    applicationNo: { required: true },
    ...YMD('applicationDate', false),
    inventionTitle: { required: true },
    patentType: { required: false },
    patentee: { required: true },
    client: { required: false },
    searcher: { required: true },
    reviewer: { required: true },
    ipcClass: { required: true },
    footerFirm: { required: true },
    distXCount: { required: true },
    distXRatio: { required: true },
    distXImpact: { required: true },
    distYCount: { required: true },
    distYRatio: { required: true },
    distYImpact: { required: true },
    distACount: { required: true },
    distARatio: { required: true },
    distAImpact: { required: true },
    distTotalCount: { required: true },
    distTotalRatio: { required: true },
    moreDocuments: { required: false, ...checkboxSlot('相关文件，参见附页', 'continued') },
    ...YMD('reportDate', true),
  },
  sections: {
    ...SEARCH_WORK_SECTIONS,
    conclusion: { required: true, kind: 'blocks' },
    searchRounds: { required: true, kind: 'rows', columns: 5 },
  },
  staticElements: [
    { marker: '第 ', reason: '页脚页码逐页不同，单一草案值无法表达；页码在打印/定稿时由人工或分页流程填写' },
    { marker: '检索覆盖中文与英文文献', reason: 'F 区三个声明为固定免责语句，是否勾选由人工定稿决定，不由草案驱动' },
    { marker: '合计', reason: '相关度分布表的类型列（X/Y/A/合计）为固定行标签，影响列固定为「—」' },
    { marker: '* 引用文件的专用类型', reason: '引用类型图例为文书固定文字' },
    { marker: '机密 · 仅供委托方使用', reason: '抬头密级声明为品牌/版式固有元素' },
    { marker: '本报告为检索分析交付物', reason: '落款声明块为固定免责声明文本' },
  ],
}

/** 两个表单模板的注册表。 */
export const FORM_TEMPLATE_SCHEMAS: Readonly<Record<FormTemplateId, TemplateSlotRegistry>> = {
  'right-evaluation-report': RIGHT_EVALUATION_SCHEMA,
  'search-report-form': SEARCH_REPORT_SCHEMA,
}

export {
  GENERIC_TEMPLATE_IDS,
  GENERIC_TEMPLATE_SCHEMAS,
  isGenericTemplateId,
} from './generic.ts'
export type { GenericTemplateId } from './generic.ts'
import type { GenericTemplateId } from './generic.ts'

/** 除 claims-spec 外全部接入受控草案的模板 id（表单 + 通用文档）。 */
type DraftTemplateId = FormTemplateId | GenericTemplateId

/** 判断模板 id 是否已接入 TemplateDraft（表单或通用文档；类型守卫）。
 * @param id - 模板 id。
 * @returns 该 id 是否为受控草案模板 id。
 */
export function isDraftTemplateId(id: DocumentTemplateId): id is DraftTemplateId {
  return isFormTemplateId(id) || isGenericTemplateId(id)
}
