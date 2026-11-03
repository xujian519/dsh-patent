/**
 * Domain-neutral description heuristics added after the form checks: background
 * citations, effect comparison, sequence listings, media in the text, term/mark
 * consistency, utility-model drawing content, and utility-model subject matter.
 *
 * Each rule is deterministic and reports a warning or error with the legal
 * basis that makes the defect actionable. None of them decides enablement or
 * support; those stay `not_assessed`.
 * @module @deepseek-ai/dsh-patent-tools/tool/spec-description-extras
 */

import { parseClaimDocument } from '@deepseek-ai/dsh-patent-core'
import { drawingEntries, getDrawingSection } from './spec-figure-marks.ts'
import { sectionBodies } from './spec-placeholder.ts'
import type { PatentType } from './draft-claims.ts'
import type { SpecViolation } from './spec-types.ts'

/** Sentences that claim a specific prior-art document. */
const CITATION_CLAIM = /(?:专利号|公开号|公告号|对比文件\s*\d|专利文献|非专利文献|期刊|论文|会议|标准)/

/** A jurisdiction token or number prefix in a patent citation. */
const CITATION_COUNTRY = /(?:CN|US|EP|JP|KR|WO|DE|FR|GB|TW)\s*\d|中国|美国|欧洲|日本|韩国|德国|英国|世界知识产权组织/

/** A document number of at least four digits. */
const CITATION_NUMBER = /(?:[A-Z]{2}\s*)?\d{4,}/

/** A publication date in Chinese or numeric form. */
const CITATION_DATE = /\d{4}\s*年|\d{4}\s*[-/.]\s*\d{1,2}|公开日|公告日|申请日/

/** Comparison markers that tie an effect to prior art. */
const EFFECT_COMPARISON = /相比|相对于|与.{0,20}相比|较现有技术|对比|现有技术/

/** Three-letter amino-acid chains joined by a hyphen. */
const AMINO_ACID_CHAIN =
  '(?:Ala|Arg|Asn|Asp|Cys|Gln|Glu|Gly|His|Ile|Leu|Lys|Met|Phe|Pro|Ser|Thr|Trp|Tyr|Val)[-–—]'

/** Sequence markers: database ids, nucleotide runs, or three-letter amino-acid chains. */
const SEQUENCE_MARKER = new RegExp(`SEQ\\s*ID\\s*NO|序列号|[ACGTU]{20,}|${AMINO_ACID_CHAIN}`, 'i')

/** An independent sequence-listing reference. */
const SEQUENCE_LISTING = /序列表|Sequence\s+Listing|ST\.26/i

/** Markdown or HTML image syntax in the specification body. */
const IMAGE_SYNTAX = /!\[[^\]]*\]\([^)]*\)|<img\b/i

/** A markdown table row. */
const TABLE_ROW = /^\s*\|.*\|\s*$/

/** Names that look like `名称（数字）` but are procedural labels, not component marks. */
const NON_COMPONENT_NAME = /^(?:实施例|步骤|式|图|表|权利要求|方案|公式|第)$/

/**
 * Background citations: a sentence that names a prior-art document must give
 * its jurisdiction, number, and date; a non-patent document must give its
 * source.
 * @param text - the specification text.
 * @returns one warning per missing citation element.
 */
export function checkBackgroundCitations(text: string): SpecViolation[] {
  const background = sectionBodies(text).find(section => section.name === '背景技术')?.body ?? ''
  if (background.trim().length === 0) return []
  const violations: SpecViolation[] = []
  for (const sentence of background.split(/[。；\n]+/)) {
    const claim = sentence.trim()
    if (claim.length === 0 || !CITATION_CLAIM.test(claim)) continue
    const isPatent = /专利|公开号|公告号|对比文件/.test(claim)
    if (isPatent) {
      const missing: string[] = []
      if (!CITATION_COUNTRY.test(claim)) missing.push('国别')
      if (!CITATION_NUMBER.test(claim)) missing.push('公开号/专利号')
      if (!CITATION_DATE.test(claim)) missing.push('公开日/公告日')
      if (missing.length > 0) {
        violations.push({
          rule: 'background_citation',
          family: 'description',
          severity: 'warning',
          section: '背景技术',
          message: `背景技术的引证缺少${missing.join('、')}：${claim.slice(0, 60)}（《专利审查指南》第二部分第二章 2.2.3）`,
          suggestion: '按「国别+公开号+公开日」写明引证文件；非专利文献写明出处、作者与日期',
        })
      }
    } else if (!/《[^》]+》|出版社|标准号/.test(claim)) {
      violations.push({
        rule: 'background_citation',
        family: 'description',
        severity: 'warning',
        section: '背景技术',
        message: `背景技术的非专利文献未注明出处：${claim.slice(0, 60)}（《专利审查指南》第二部分第二章 2.2.3）`,
        suggestion: '写明文献名称、作者、出处与公开日期',
      })
    }
  }
  return violations
}

/**
 * Beneficial effects must be tied to prior art; an effect sentence without a
 * comparison object cannot support inventiveness.
 * @param text - the specification text.
 * @returns one warning when the effect passage has no comparison object.
 */
export function checkEffectComparison(text: string): SpecViolation[] {
  const summary = sectionBodies(text).find(section => section.name === '发明内容')?.body ?? ''
  const start = summary.indexOf('有益效果')
  if (start < 0) return []
  /* v8 ignore next -- split always yields at least one element. */
  const effects = summary.slice(start).split(/\n{2,}/)[0]?.trim() ?? ''
  if (Array.from(effects).length < 12 || EFFECT_COMPARISON.test(effects)) return []
  return [{
    rule: 'effect_prior_art_comparison',
    family: 'description',
    severity: 'warning',
    section: '发明内容',
    message: '有益效果未与现有技术对比：缺少「相比现有技术」「相对于……」一类对比对象（《专利审查指南》第二部分第二章 2.2.4）',
    suggestion: '补充与最接近现有技术的对比，说明改进幅度或预料不到的技术效果',
  }]
}

/**
 * A sequence in the text requires a separate sequence listing.
 * @param text - the specification text.
 * @returns one warning when a sequence is present without a listing reference.
 */
export function checkSequenceListing(text: string): SpecViolation[] {
  if (!SEQUENCE_MARKER.test(text) || SEQUENCE_LISTING.test(text)) return []
  return [{
    rule: 'sequence_listing',
    family: 'description',
    severity: 'warning',
    message: '说明书出现核苷酸/氨基酸序列，但未提及独立序列表（《专利法实施细则》第二十条第四款；指南第二部分第十章 9.2）',
    suggestion: '把序列写入符合 ST.26 的独立序列表，并在说明书中注明其与本申请的对应关系',
  }]
}

/**
 * Images and tables in the description: images never belong in the text;
 * tables belong in 具体实施方式.
 * @param text - the specification text.
 * @returns one image error and one warning per table outside 具体实施方式.
 */
export function checkTextMedia(text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  if (IMAGE_SYNTAX.test(text)) {
    violations.push({
      rule: 'image_in_text',
      family: 'description',
      severity: 'error',
      message: '说明书文字部分出现图片（Markdown 图片或 <img>）：附图应作为独立附图提交，不能嵌入说明书正文（《专利审查指南》第二部分第二章 2.2.7）',
      suggestion: '删除正文中的图片，改为在「附图说明」中列出并在说明书附图中提交',
    })
  }
  for (const section of sectionBodies(text)) {
    if (section.name === '具体实施方式') continue
    if (!section.body.split('\n').some(line => TABLE_ROW.test(line))) continue
    violations.push({
      rule: 'table_outside_embodiment',
      family: 'description',
      severity: 'warning',
      section: section.name,
      message: `「${section.name}」出现表格：表格仅宜放在具体实施方式，用于参数或对照数据（《专利审查指南》第二部分第二章 2.2.7）`,
      suggestion: '把表格移入具体实施方式，或在正文中以文字叙述',
    })
  }
  return violations
}

/**
 * Reduce the Chinese text before a parenthesized mark to the component name.
 * Verbs and connectors introduce the mark (`包括壳体（1）`), so the last
 * segment after them is the noun.
 * @param raw - the captured text before the mark.
 * @returns the component name, or an empty string when only a connector remains.
 */
function componentName(raw: string): string {
  const segments = raw.split(/包括|设有|设置于|安装于|连接于|固定于|位于|具有|以及|与|和|及|或|在|其|该|本|所述/)
  /* v8 ignore next -- split always yields at least one element. */
  return (segments.at(-1) ?? '').trim()
}

/**
 * A reference mark must name one component and a component name must use one
 * mark. Only `名称（数字）` pairs are compared, so quantities and figure
 * references do not enter the maps.
 * @param text - the specification text.
 * @returns one warning per mark or name used inconsistently.
 */
export function checkTermConsistency(text: string): SpecViolation[] {
  const byRef = new Map<string, Set<string>>()
  const byName = new Map<string, Set<string>>()
  for (const match of text.matchAll(/([\u4e00-\u9fff]{2,12})\s*[（(]\s*(\d{1,4})\s*[）)]/g)) {
    /* v8 ignore next -- the pattern always captures the name group. */
    const name = componentName(match[1] ?? '')
    /* v8 ignore next -- the pattern always captures the reference group. */
    const ref = match[2] ?? ''
    if (name.length < 2 || NON_COMPONENT_NAME.test(name)) continue
    const names = byRef.get(ref) ?? new Set<string>()
    names.add(name)
    byRef.set(ref, names)
    const refs = byName.get(name) ?? new Set<string>()
    refs.add(ref)
    byName.set(name, refs)
  }
  const violations: SpecViolation[] = []
  for (const [ref, names] of byRef) {
    if (names.size < 2) continue
    violations.push({
      rule: 'term_mark_consistency',
      family: 'figures',
      severity: 'warning',
      message: `附图标记 ${ref} 对应多个部件名：${[...names].join('、')}（《专利审查指南》第二部分第二章 2.2.6）`,
      suggestion: '同一标号只对应一个部件，统一部件名称或重新编号',
    })
  }
  for (const [name, refs] of byName) {
    if (refs.size < 2) continue
    violations.push({
      rule: 'term_mark_consistency',
      family: 'figures',
      severity: 'warning',
      message: `部件「${name}」使用了多个附图标记：${[...refs].join('、')}（《专利审查指南》第二部分第二章 2.2.6）`,
      suggestion: '同一部件在全文使用同一标号，或确认是否为不同部件',
    })
  }
  return violations
}

/**
 * A utility model needs drawings that show the claimed structure; prior-art
 * drawings or performance curves alone do not qualify.
 * @param text - the specification text.
 * @param patentType - the application type; other types are not checked.
 * @returns one warning when every drawing entry is a prior-art or curve figure.
 */
export function checkUtilityModelFigureContent(text: string, patentType: PatentType | undefined): SpecViolation[] {
  if (patentType !== 'utility_model') return []
  const entries = drawingEntries(getDrawingSection(text))
  const names = entries.map(entry => entry.name.trim()).filter(name => name.length > 0)
  if (names.length === 0) return []
  const nonStructural = names.every(name => /现有技术|对比文件|性能曲线|效果曲线|特性曲线/.test(name))
  if (!nonStructural) return []
  return [{
    rule: 'utility_model_figure_content',
    family: 'figures',
    severity: 'warning',
    section: '附图说明',
    message: '实用新型的附图均为现有技术图或性能曲线图：应提交表示要求保护的产品的形状、构造的附图（《专利审查指南》第一部分第二章 7.3）',
    suggestion: '补充产品的结构视图（主视图、剖视图、爆炸图等），删除或标注现有技术图',
  }]
}

/** 权利要求主题名称落在末尾的方法或工艺表述（实用新型不含方法主题）。 */
const METHOD_SUBJECT = /(?:方法|工艺|步骤)$/

/** 权利要求主题名称落在末尾的组合物或无固定形状产品表述。 */
const COMPOSITION_SUBJECT = /(?:组合物|混合物|配方|涂料|润滑脂|溶液|乳液|悬浮液|粉体|粉末)$/

/**
 * A utility model protects only a product's shape, structure, or their
 * combination, so a claim whose subject is a method or a composition is not
 * admissible subject matter for it. The subject name is read from the parsed
 * claim (text after「一种」for an independent claim, after「所述」for a
 * dependent one), and only its ending decides, so a device named for the
 * process it performs («用于制造螺栓的模具») is not flagged.
 * @param claims - the claims text; absent or blank input is not checked.
 * @param patentType - the application type; only `utility_model` is checked.
 * @returns one error per offending claim, in claim order.
 */
export function checkUtilityModelSubjectMatter(
  claims: string | undefined,
  patentType: PatentType | undefined,
): SpecViolation[] {
  if (patentType !== 'utility_model') return []
  if (claims === undefined || claims.trim().length === 0) return []
  const violations: SpecViolation[] = []
  for (const claim of parseClaimDocument(claims).claims) {
    const subject = claim.subject.trim()
    if (subject.length === 0) continue
    if (METHOD_SUBJECT.test(subject)) {
      violations.push({
        rule: 'utility_model_method_claim',
        family: 'claims',
        severity: 'error',
        message: `实用新型不得包含方法主题：第 ${claim.number} 项权利要求的主题为「${subject}」，《专利法》第二条第三款只保护产品的形状、构造或者其结合`,
        suggestion: '方法主题不属于实用新型客体：将方法另案申请发明，本案改写为产品权利要求，或整体改以发明提出申请',
      })
      continue
    }
    if (COMPOSITION_SUBJECT.test(subject)) {
      violations.push({
        rule: 'utility_model_composition',
        family: 'claims',
        severity: 'error',
        message: `实用新型不得保护组合物或无固定形状产品：第 ${claim.number} 项权利要求的主题为「${subject}」，《专利法》第二条第三款只保护产品的形状、构造或者其结合`,
        suggestion: '组合物与无固定形状的产品不属于实用新型客体：改以发明提出申请，或把主题改写为具有确定形状、构造的产品',
      })
    }
  }
  return violations
}
