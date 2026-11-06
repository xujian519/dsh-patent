/**
 * Chemistry filing checks: claim form for medical uses, Markush optional
 * substitution, composition percentages, and the disclosure gaps that make a
 * chemical claim unsupported or non-reproducible.
 *
 * Every rule is gated on `tech_domain: 'chemical'`: the same wording carries a
 * different meaning elsewhere (「高温」in a metallurgy filing is a process
 * parameter, 「载体」in a catalyst filing is not a biological vector), so running
 * these rules domain-blind would report the other domains' filings. A hit means
 * the drafting needs review — whether the defect is fatal stays a legal
 * judgement, which is why only the medical-use subject and the missing deposit
 * reach `error`.
 * @module @deepseek-ai/dsh-patent-tools/tool/spec-chemical
 */

import { locateMatch } from '@deepseek-ai/dsh-patent-core'
import type { TechDomain } from './draft-claims.ts'
import { claimSubjects } from './internal/claim-subjects.ts'
import type { SpecViolation } from './spec-types.ts'

/** A comparative degree word followed by an adjective: relative without a stated reference. */
const RELATIVE_TERM = /(?:较|很|极|非常|过于|更)(?:高|低|大|小|厚|薄|宽|窄|长|短|强|弱)/

/**
 * Parameter nouns whose value needs a unit. `pH` is left out because it is
 * dimensionless, and a value inside a numeric range is left out because the
 * range endpoints carry the unit once.
 */
const UNIT_PARAMETER = /(?:温度|压力|时间|浓度|含量|纯度|收率|产率|分子量|重均分子量|数均分子量|质量|重量|体积|转速|流速|粘度|黏度|粒径|比表面积|孔径|厚度|宽度)/

/** A unit or a Chinese unit name that may follow a parameter value. */
// oxlint-disable-next-line @stylistic/max-len -- a unit alternation is clearer as one list than split across lines
const UNIT_SUFFIX = /(?:[%℃°]|wt|vol|mg|g|kg|t|ml|mL|L|l|μm|um|nm|mm|cm|m|mol|mmol|h|min|s|rpm|Pa|kPa|MPa|K|Da|kDa|道尔顿|分钟|小时|秒|天|周|月|年|摄氏度|度|重量份|份|当量|倍|个|层|次|项|种)/

/** Biological material whose public availability A26.3 hinges on a deposit. */
const BIOLOGICAL_MATERIAL = /(?:菌株|菌种|微生物|细胞株|细胞系|杂交瘤|转化体|宿主细胞|噬菌体|质粒|工程菌)/

/** Deposit wording that makes the biological material available to the public. */
const DEPOSIT_MARKER = /(?:保藏|CCTCC|CGMCC|ATCC|DSM\s*\d|NBRC|CIP\s*\d|保藏编号|保藏日期|保藏单位)/

/** A declaration that a group is optionally substituted without naming the substituents. */
const OPTIONAL_SUBSTITUTION = /(?:任选取代|任意取代|取代或未取代)/

/** Terms that define a Markush group's substituents. */
const SUBSTITUENT_DEFINITION = /(?:选自|独立地选自|为氢|为烷基|为芳基|为卤素|为羟基|为氨基|为氰基|为硝基|为羧基)/

/** Drug subjects that need an indication in the claim or an explicit use limitation. */
const DRUG_SUBJECT = /(?:药物|药物组合物|药物制剂|药用|医药|疫苗|抗体药物|活性成分)/

/** Disease or treatment wording that supplies the indication. */
const INDICATION_TERM = /(?:用于治疗|用于预防|用于诊断|适应症|适应证|疾病|病症|肿瘤|癌症|感染|炎症|糖尿病|高血压|高血脂|疼痛|溃疡|病毒)/

/** A claim subject that names a method of treatment or diagnosis. */
const MEDICAL_METHOD_SUBJECT = /(?:治疗|预防|诊断)[^，。；]{0,20}方法$/

/** A use claim subject, which must take the「在制备…药物中的用途」form for a second medical use. */
const USE_SUBJECT = /(?:用途|应用)$/

/** The Swiss-type form that keeps a second medical use outside A25.1.3. */
const PREPARATION_USE = /在制备[^。；]{0,40}(?:药物| medicament)[^。；]{0,20}(?:中|中的)?(?:的)?(?:用途|应用)/

/** A percentage, optionally a range, as written in a composition claim. */
const PERCENTAGE = /(\d+(?:\.\d+)?)\s*(?:%|％|wt\s*%|重量\s*%)(?:\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*(?:%|％|wt\s*%|重量\s*%)?)?/g

/** Wording that gives the balance of a composition, so range maxima may legitimately exceed 100. */
const BALANCE_TERM = /(?:余量|余下|补足|加至|加水至)/

/** A Markush or generic-structure mention. */
const MARKUSH_TERM = /(?:通式|马库什|Markush)/

/** An embodiment number, Arabic or Chinese. */
const EMBODIMENT = /实施例\s*([0-9]+|[一二三四五六七八九十百零〇两]+)/g

/** A Chinese numeral from 1 to 99; `undefined` for anything the parser does not own. */
const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** Herb and prescription wording that triggers the traditional-medicine source check. */
const HERB_PRESCRIPTION = /(?:中药|中药材|药材|饮片)/

/** A measured herb amount, which a traditional-medicine prescription states in mass. */
const HERB_AMOUNT = /\d+(?:\.\d+)?\s*(?:g|克|kg|千克|mg|毫克|重量份|份)/

/** A Latin binomial, the form a pharmacopoeia uses for a herb's botanical source. */
const LATIN_BINOMIAL = /\b[A-Z][a-z]{2,}\s+[a-z]{2,}\b/

/** Wording that claims a combined effect, which normally needs a comparative example. */
const SYNERGY_TERM = /(?:协同|复配|协同增效|复配增效)/

/** Wording that supplies the comparative example. */
const COMPARATIVE_EXAMPLE = /(?:对比例|比较例|对照例|对比实验|对比实施例)/

/**
 * Subject-matter and form rules that read the claims.
 * @param claims - the claims text; absent or blank input is not checked.
 * @param techDomain - the declared technical domain; only `chemical` is checked.
 * @returns one violation per offending independent claim, in claim order.
 */
export function checkChemicalClaimSubjectMatter(
  claims: string | undefined,
  techDomain: TechDomain | undefined,
): SpecViolation[] {
  if (techDomain !== 'chemical') return []
  if (claims === undefined || claims.trim().length === 0) return []
  const violations: SpecViolation[] = []
  for (const claim of claimSubjects(claims)) {
    const { number, subject, text } = claim
    const medicalMethod = MEDICAL_METHOD_SUBJECT.test(subject)
    if (medicalMethod) {
      violations.push({
        rule: 'chem_medical_use_method',
        family: 'claims',
        severity: 'error',
        message: `第 ${number} 项权利要求的主题「${subject}」是疾病的治疗或诊断方法：属于不授予专利权的客体（《专利法》第二十五条第一款第三项）`,
        suggestion: '改写为「…在制备治疗…的药物中的用途」或「一种用于治疗…的药物组合物」，把保护对象落到产品；需要保护给药方案时另行评估',
      })
      continue
    }
    if (USE_SUBJECT.test(subject) && /(?:治疗|预防)/.test(text) && !PREPARATION_USE.test(text)) {
      violations.push({
        rule: 'chem_second_use_form',
        family: 'claims',
        severity: 'warning',
        message: `第 ${number} 项用途权利要求直接限定「${subject}」的治病效果，未写成制备药物的用途：可能被认定为疾病的治疗方法（《专利法》第二十五条第一款第三项；《专利审查指南》第二部分第一章 4.3）`,
        suggestion: '改写为「化合物 X 在制备治疗 Y 的药物中的用途」，或写成「用于治疗 Y 的药物组合物」产品权利要求',
      })
    }
    if (RELATIVE_TERM.test(text)) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the test above matched the same pattern
      const term = RELATIVE_TERM.exec(text)![0]
      violations.push({
        rule: 'chem_relative_term',
        family: 'claims',
        severity: 'warning',
        message: `第 ${number} 项权利要求使用相对表述「${term}」：化学参数缺少可比基准，保护范围不清楚（《专利法》第二十六条第四款）`,
        suggestion: '改用可测量的绝对数值或明确基准（如「相对于…提高 20%」「平均粒径 5–20 μm」），并在说明书中给出测量方法',
      })
    }
    if (OPTIONAL_SUBSTITUTION.test(text) && !SUBSTITUENT_DEFINITION.test(text)) {
      violations.push({
        rule: 'chem_markush_optional_undefined',
        family: 'claims',
        severity: 'warning',
        message: `第 ${number} 项权利要求出现「任选取代」但未限定可取代基的种类与位置：马库什通式的保护范围不清楚（《专利法》第二十六条第四款；《专利审查指南》第二部分第十章）`,
        suggestion: '逐一列出可选的取代基（如「各自独立地选自氢、C1–C6 烷基、卤素、羟基、氨基」），并说明取代位置与取代数量',
      })
    }
    const compositionTotal = compositionTotalViolation(number, subject, text)
    if (compositionTotal !== undefined) violations.push(compositionTotal)
    if (DRUG_SUBJECT.test(subject) && !/(?:制备|合成)/.test(subject) && !INDICATION_TERM.test(text)) {
      violations.push({
        rule: 'chem_indication_missing',
        family: 'claims',
        severity: 'warning',
        message: `第 ${number} 项药物权利要求「${subject}」未限定治疗或预防的适应症：用途不清楚，说明书也难以支持（《专利法》第二十六条第四款）`,
        suggestion: '在权利要求中写明适应症（如「用于治疗糖尿病」），或在说明书中限定该药物组合物的用途并与权项对应',
      })
    }
  }
  return violations
}

/**
 * Composition percentages whose upper bounds add up past 100%. The rule reads
 * one claim at a time and only when at least two percentages are stated; a
 * composition that states「余量」is skipped because its ranges may overlap on
 * purpose.
 * @param number - the claim number, for the message.
 * @param subject - the claim subject.
 * @param text - the claim text.
 * @returns the violation, or `undefined` when the percentages are consistent or absent.
 */
function compositionTotalViolation(number: number, subject: string, text: string): SpecViolation | undefined {
  if (!/(?:组合物|组合|配方|重量份)/.test(subject) && !/(?:组合物|组合|配方)/.test(text)) return undefined
  if (BALANCE_TERM.test(text)) return undefined
  let maximum = 0
  let count = 0
  for (const match of text.matchAll(PERCENTAGE)) {
    count += 1
    maximum += Number(match[2] ?? match[1])
  }
  if (count < 2 || maximum <= 100) return undefined
  return {
    rule: 'chem_composition_total',
    family: 'claims',
    severity: 'warning',
    message: `第 ${number} 项组合物权利要求的各组分上限合计 ${maximum}%，超过 100%：组分含量范围不清楚（《专利法》第二十六条第四款；《专利审查指南》第二部分第十章）`,
    suggestion: '把上限合计收敛到 100% 以内，或用「余量」「补足至 100%」限定平衡组分，并检查各范围的端点组合是否都可实施',
  }
}

/**
 * Disclosure rules that read the specification and the claims.
 * @param text - the specification text; blank input is not checked.
 * @param claims - the claims text, used for the deposit check; may be empty.
 * @param techDomain - the declared technical domain; only `chemical` is checked.
 * @returns the disclosure violations, in rule order.
 */
export function checkChemicalDisclosure(
  text: string,
  claims: string | undefined,
  techDomain: TechDomain | undefined,
): SpecViolation[] {
  if (techDomain !== 'chemical') return []
  if (text.trim().length === 0) return []
  return [
    ...unitViolations(text),
    ...embodimentNumberingViolations(text),
    ...markushDisclosureViolations(text),
    ...herbSourceViolations(text),
    ...depositViolations(text, claims ?? ''),
    ...comparativeExampleViolations(text),
  ]
}

/**
 * A parameter value written without a unit and closed by punctuation, e.g.
 * 「温度为 80，」. Values inside a range or followed by a unit are ignored.
 * @param text - the specification text.
 * @returns one warning listing up to three offending phrases.
 */
function unitViolations(text: string): SpecViolation[] {
  const pattern = new RegExp(
    `${UNIT_PARAMETER.source}\\s*(?:为|是|在|达到|控制在|设定为)?\\s*\\d+(?:\\.\\d+)?(?!\\s*(?:${UNIT_SUFFIX.source})|\\s*(?:-|~|～|至|到)\\s*\\d)\\s*[，。；、,;]`,
  )
  const phrases: string[] = []
  for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
    phrases.push(match[0].replace(/[，。；、,;]$/, ''))
    if (phrases.length >= 3) break
  }
  if (phrases.length === 0) return []
  // oxlint-disable-next-line typescript/no-non-null-assertion -- phrases are substrings of text, so a location exists
  const location = locateMatch(text, phrases)!
  return [{
    rule: 'chem_unit_missing',
    family: 'description',
    severity: 'warning',
    section: '具体实施方式',
    message: `化学参数缺少计量单位：${phrases.join('；')}（《专利法》第二十六条第三款、第四款）`,
    suggestion: '为每个参数补上单位并统一量纲（如「温度 80 ℃」「压力 0.5 MPa」「时间 2 h」），同一参数在全文中使用同一单位',
    line: location.line,
    matchedSentence: location.matchedSentence,
  }]
}

/**
 * Embodiment numbers that repeat or skip. Only a run with at least two
 * parseable numbers is checked, so an unrelated「实施例」mention is not reported.
 * @param text - the specification text.
 * @returns one warning when numbers repeat or a gap appears.
 */
function embodimentNumberingViolations(text: string): SpecViolation[] {
  const numbers: number[] = []
  for (const match of text.matchAll(EMBODIMENT)) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern's only capture group always participates
    const value = parseEmbodimentNumber(match[1]!)
    if (value === undefined) return []
    numbers.push(value)
  }
  if (numbers.length < 2) return []
  const duplicates = numbers.filter((value, index) => numbers.indexOf(value) !== index)
  const unique = [...new Set(numbers)].sort((a, b) => a - b)
  const gaps: number[] = []
  // oxlint-disable-next-line typescript/no-non-null-assertion -- numbers.length >= 2 guarantees a first and a last entry
  const first = unique[0]!
  // oxlint-disable-next-line typescript/no-non-null-assertion -- numbers.length >= 2 guarantees a first and a last entry
  const last = unique[unique.length - 1]!
  for (let value = first + 1; value < last; value += 1) {
    if (!unique.includes(value)) gaps.push(value)
  }
  if (duplicates.length === 0 && gaps.length === 0) return []
  const detail = [
    duplicates.length === 0 ? '' : `重复：${[...new Set(duplicates)].join('、')}`,
    gaps.length === 0 ? '' : `缺号：${gaps.join('、')}`,
  ].filter(part => part.length > 0).join('；')
  return [{
    rule: 'chem_embodiment_numbering',
    family: 'description',
    severity: 'warning',
    section: '具体实施方式',
    message: `实施例编号不连续或重复（${detail}）：实施例顺序影响对范围支持的认定（《专利审查指南》第二部分第十章）`,
    suggestion: '按出现顺序连续编号实施例，删除重复编号；仅在确有对比意义时使用「对比例」编号，并单独成组',
  }]
}

/**
 * Parse an embodiment number written in Arabic or Chinese digits.
 * @param raw - the matched number text.
 * @returns the number, or `undefined` when the form is not a plain 1–99 numeral.
 */
function parseEmbodimentNumber(raw: string): number | undefined {
  if (/^[0-9]+$/.test(raw)) return Number(raw)
  const tenIndex = raw.indexOf('十')
  if (tenIndex === -1) {
    if (raw.length !== 1) return undefined
    return CHINESE_DIGITS[raw]
  }
  const tens = tenIndex === 0 ? 1 : CHINESE_DIGITS[raw.slice(0, tenIndex)]
  const ones = tenIndex === raw.length - 1 ? 0 : CHINESE_DIGITS[raw.slice(tenIndex + 1)]
  if (tens === undefined || ones === undefined) return undefined
  return tens * 10 + ones
}

/**
 * A Markush disclosure that declares optional substitution but never defines
 * the substituents, leaving the generic structure open-ended.
 * @param text - the specification text.
 * @returns one warning when the substituent list is absent.
 */
function markushDisclosureViolations(text: string): SpecViolation[] {
  if (!MARKUSH_TERM.test(text)) return []
  if (!OPTIONAL_SUBSTITUTION.test(text)) return []
  if (SUBSTITUENT_DEFINITION.test(text)) return []
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the matched term is a substring of text
  const location = locateMatch(text, [MARKUSH_TERM.exec(text)![0]])!
  return [{
    rule: 'chem_markush_optional_undefined',
    family: 'description',
    severity: 'warning',
    section: '发明内容',
    message: '说明书使用马库什通式并声明「任选取代」，但未限定可选的取代基种类与位置：通式公开不充分（《专利法》第二十六条第三款、第四款；《专利审查指南》第二部分第十章）',
    suggestion: '为通式中的每个 R 基列出可选取代基清单、取代位置与数量，并给出至少一个落入通式范围的具体化合物实施例',
    line: location.line,
    matchedSentence: location.matchedSentence,
  }]
}

/**
 * A traditional-medicine prescription that gives herb amounts but no botanical
 * source. The Latin binomial is what makes the herb's origin verifiable.
 * @param text - the specification text.
 * @returns one warning when the botanical source is absent.
 */
function herbSourceViolations(text: string): SpecViolation[] {
  if (!HERB_PRESCRIPTION.test(text)) return []
  if (!HERB_AMOUNT.test(text)) return []
  if (LATIN_BINOMIAL.test(text)) return []
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the matched term is a substring of text
  const location = locateMatch(text, [HERB_PRESCRIPTION.exec(text)![0]])!
  return [{
    rule: 'chem_herb_source',
    family: 'description',
    severity: 'warning',
    section: '具体实施方式',
    message: '中药处方的药材只写名称与用量，未记载基源（植物学名与药用部位）：药材来源不确定，方案无法重复实施（《专利法》第二十六条第三款；《专利审查指南》第二部分第十章）',
    suggestion: '为每味药材补写基源（如「黄芪，豆科植物蒙古黄芪 Astragalus membranaceus var. mongholicus 的干燥根」）、药用部位与炮制方法',
    line: location.line,
    matchedSentence: location.matchedSentence,
  }]
}

/**
 * Biological material mentioned without a deposit. Whether a deposit is
 * required depends on public availability, so the rule reports a warning rather
 * than an error.
 * @param text - the specification text.
 * @param claims - the claims text, where the same material may be claimed.
 * @returns one warning when a mentioned material carries no deposit information.
 */
function depositViolations(text: string, claims: string): SpecViolation[] {
  const combined = `${text}\n${claims}`
  const material = BIOLOGICAL_MATERIAL.exec(combined)?.[0]
  if (material === undefined) return []
  if (DEPOSIT_MARKER.test(combined)) return []
  return [{
    rule: 'chem_biological_deposit',
    family: 'description',
    severity: 'warning',
    message: `申请涉及生物材料「${material}」，但说明书与权利要求书均未记载保藏信息：公众可能无法获得该材料（《专利法》第二十六条第三款）`,
    suggestion: '若该材料公众不能得到，补写保藏单位名称、地址、保藏日期与保藏编号（如「CCTCC NO: C2024123」），并在请求书中声明；已有公开来源的，写明来源与获取方式',
  }]
}

/**
 * A claimed synergy with no comparative example anywhere in the specification.
 * @param text - the specification text.
 * @returns one warning when the synergy claim has no comparison.
 */
function comparativeExampleViolations(text: string): SpecViolation[] {
  if (!SYNERGY_TERM.test(text)) return []
  if (COMPARATIVE_EXAMPLE.test(text)) return []
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the matched term is a substring of text
  const location = locateMatch(text, [SYNERGY_TERM.exec(text)![0]])!
  return [{
    rule: 'chem_comparative_example_missing',
    family: 'description',
    severity: 'warning',
    section: '具体实施方式',
    message: '说明书主张协同或复配效果，但未记载对比例：无法确认该效果相对于单组分是否成立（《专利法》第二十六条第三款；《专利审查指南》第二部分第十章）',
    suggestion: '补充单组分对照与不含该组分的空白对照，给出同一测试条件下的定量结果，并把效果数据与区别技术特征对应',
    line: location.line,
    matchedSentence: location.matchedSentence,
  }]
}
