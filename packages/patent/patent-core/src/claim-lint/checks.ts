/**
 * src/claim-lint — 权利要求书形式自检的规则实现。
 *
 * 每条规则对应权利要求书撰写形式的一项可机械判定要求（法条与指南节号见 BASIS），
 * 报告里带所依据的条款。用语类规则（功能性、工艺、非技术效果、商业宣传）是词表启发式：
 * 命中不等于违规，只说明该写法需要代理师过一眼；结构性规则（编号、引用、引用基础、
 * 主题名称、标点）则是确定性的。
 *
 * 用词表在特征部分生效——句首「一种…」的前序部分是主题限定，那里的「用于」不构成
 * 功能性限定。
 */

import { findAntecedentGaps } from './antecedent.ts'
import { parseClaimDocument, type ParsedClaimDocument } from './parse.ts'
import type { ClaimLintFinding, ClaimLintOptions, ClaimLintReport, ClaimLintRuleId, ParsedClaim } from './types.ts'

/** 规范依据（报告逐条携带）。指南节号只取随包索引已登记的节。 */
const BASIS: Readonly<Record<ClaimLintRuleId, string>> = {
  numbering: '《专利法实施细则》第二十二条第二款（权利要求应当用阿拉伯数字顺序编号）',
  'reference-direction': '《专利法实施细则》第二十五条第二款；审查指南第二部分第二章 3.3.2',
  'multiple-dependent': '《专利法实施细则》第二十五条第二款；审查指南第二部分第二章 3.3.2',
  'antecedent-basis': '《专利法》第二十六条第四款；审查指南第二部分第二章 3.2.2',
  'subject-consistency': '《专利法实施细则》第二十五条第一款；审查指南第二部分第二章 3.3.2',
  'dependent-limitation': '《专利法实施细则》第二十三条第三款；审查指南第二部分第二章 3.3.2',
  'two-part-form': '《专利法实施细则》第二十四条第一款；审查指南第二部分第二章 3.3.1',
  'functional-limitation': '《专利法》第二十六条第四款；审查指南第二部分第二章 3.2.1',
  'process-feature': '《专利法》第二条第三款；审查指南第二部分第二章 3.2.2',
  'step-order': '《专利法》第二十六条第四款（清楚）；审查指南第二部分第二章 3.2.2',
  'non-technical-feature': '《专利法实施细则》第二十二条第一款；审查指南第二部分第二章 3.2.2',
  'commercial-language': '《专利法实施细则》第二十二条第一款；审查指南第二部分第二章 3.2.2',
  'external-reference': '《专利法实施细则》第二十二条第三款；审查指南第二部分第二章 3.2.2',
  terminator: '《专利法实施细则》第二十二条第一款；审查指南第二部分第二章 3.3',
  'claim-count': '本案撰写约束（项数上限由撰写指令给定，非法定上限）',
  'non-claim-content': '《专利法实施细则》第二十二条第一款；审查指南第二部分第二章 3.3',
}

/** 功能性/效果性限定的常见句式。 */
const FUNCTIONAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /由[^，。；]{0,20}(?:产生|决定|确定)/, label: '「由……产生/决定」' },
  { pattern: /用于/, label: '「用于……」用途性表述' },
  { pattern: /(?:以便|使得|从而使|进而|有利于|从而提高|从而实现|以确保)/, label: '目的或效果连接词' },
  { pattern: /能够(?:实现|保证|确保|提高|满足)/, label: '能力性表述' },
  { pattern: /(?:起到|具有)[^，。；]{0,12}(?:作用|效果)/, label: '作用性表述' },
]

/** 工艺方法特征（实用新型不保护方法）。「层叠」是撰写实务认可的替代写法，不入表。 */
const PROCESS_PATTERN = /(?:冲压|冲裁|叠压|压铸|铸造|锻造|注塑|热处理|机加工|涂覆|焊接|压制|制成|制备|成型|加工(?![孔面]))/

/** 步骤式撰写：「包括步骤」「包括以下处理步骤」「步骤如下」等列举句式。 */
const STEP_LIST_PATTERN = /(?:包括|包含)(?:以下|下述|如下)?[^，。；]{0,6}步骤|步骤如下/

/** 已声明步骤顺序的用语；出现任一即视为顺序已明确。 */
const STEP_ORDER_PATTERN = /依次|顺序|先后/

/** 主题名称落在「方法」「工艺」上的权利要求。 */
const METHOD_SUBJECT_PATTERN = /(?:方法|工艺)$/

/** 不产生技术效果的特征。 */
const NON_TECHNICAL_PATTERN = /(?:美观|装饰|商标|品牌|型号|广告|价格|销量|市场份额|经济效益)/

/** 商业性宣传与贬低性用语。 */
const COMMERCIAL_PATTERN = /(?:最好|最佳|最优|领先|独创|国内首创|世界领先|填补空白|功能强大|市场前景|假冒|仿制|劣质)/

/** 引用说明书或附图的用语。 */
const EXTERNAL_REFERENCE_PATTERN =
  /(?:如说明书[^，。；]{0,12}所述|参见说明书|见说明书|如附图[^，。；]{0,8}所示|参见附图|见附图|如图\s*[0-9一二三四五六七八九十]*\s*所示)/

/** 从属权利要求的限定部分引导词。 */
const LIMITATION_MARKER = /其特征在于|其中/

/**
 * 取特征部分：句首「一种…，」是主题限定，用词表只在其后生效。
 * @param text - 权利要求全文。
 * @returns 第一个逗号之后的文本；没有逗号时返回全文。
 */
function characteristicPart(text: string): string {
  const comma = text.indexOf('，')
  return comma < 0 ? text : text.slice(comma + 1)
}

/**
 * 收集一项权利要求所引用权项（含交叉引用）的全文，按引用链传递闭包。
 * @param claim - 本项权利要求。
 * @param byNumber - 权项号到权利要求的索引。
 * @returns 引用链上全部权项全文的拼接；无引用时为空串。
 */
function priorTextOf(claim: ParsedClaim, byNumber: ReadonlyMap<number, ParsedClaim>): string {
  const seen = new Set<number>()
  const queue = [...claim.references, ...claim.crossReferences]
  const parts: string[] = []
  // 数组迭代器每步重读 length，本次循环追加的引用也会被访问。
  for (const number of queue) {
    if (seen.has(number)) continue
    seen.add(number)
    const target = byNumber.get(number)
    if (target === undefined) continue
    parts.push(target.text)
    queue.push(...target.references, ...target.crossReferences)
  }
  return parts.join('')
}

/**
 * 造一条发现（把规范依据与规则绑定，避免逐处重复传 basis）。
 * @param rule - 规则标识。
 * @param claim - 权项号；文档级为 null。
 * @param severity - 严重度。
 * @param message - 说明。
 * @param evidence - 原文片段。
 * @returns 一条发现。
 */
function finding(
  rule: ClaimLintRuleId,
  claim: number | null,
  severity: 'error' | 'warning',
  message: string,
  evidence: string,
): ClaimLintFinding {
  return { rule, claim, severity, message, evidence, basis: BASIS[rule] }
}

/**
 * 用语类规则：在同一段文本上跑多个词表，每类命中最多报一处。
 * @param claimNumber - 权项号。
 * @param text - 待扫文本（特征部分）。
 * @param pattern - 词表或句式。
 * @param rule - 规则标识。
 * @param severity - 严重度。
 * @param describe - 由命中构造说明。
 * @returns 发现列表。
 */
function scanPattern(
  claimNumber: number,
  text: string,
  pattern: RegExp,
  rule: ClaimLintRuleId,
  severity: 'error' | 'warning',
  describe: (hit: string) => string,
): ClaimLintFinding[] {
  const hit = pattern.exec(text)
  if (hit === null) return []
  return [finding(rule, claimNumber, severity, describe(hit[0]), hit[0])]
}

/**
 * 单项权利要求的全部规则。
 * @param claim - 解析后的权利要求。
 * @param index - 在原文中的序号（0 起）。
 * @param byNumber - 权项号到权利要求的索引。
 * @returns 发现列表。
 */
function lintClaim(
  claim: ParsedClaim,
  index: number,
  byNumber: ReadonlyMap<number, ParsedClaim>,
): ClaimLintFinding[] {
  const findings: ClaimLintFinding[] = []
  const number = claim.number
  const head = claim.text.slice(0, 20)

  if (number !== index + 1) {
    findings.push(finding(
      'numbering',
      number,
      'error',
      `第 ${index + 1} 项权利要求的编号为 ${number}；权利要求应当自 1 起用阿拉伯数字连续编号。`,
      head,
    ))
  }

  const characteristic = characteristicPart(claim.text)
  const clause = claim.referenceClause ?? ''

  for (const reference of claim.references) {
    if (!byNumber.has(reference)) {
      findings.push(finding(
        'reference-direction',
        number,
        'error',
        `本项引用了不存在的权利要求 ${reference}。`,
        clause,
      ))
      continue
    }
    if (reference >= number) {
      findings.push(finding(
        'reference-direction',
        number,
        'error',
        `本项引用了在后的权利要求 ${reference}；从属权利要求只能引用在前的权利要求。`,
        clause,
      ))
    }
  }

  if (claim.references.length > 1 && /[和及]/.test(clause)) {
    findings.push(finding(
      'multiple-dependent',
      number,
      'error',
      '引用两项以上权利要求的多项从属权利要求只能以择一方式引用；本项的引用部分使用了「和/及」并列。',
      clause,
    ))
  }
  for (const reference of claim.references) {
    const target = byNumber.get(reference)
    if (target === undefined || target.references.length <= 1) continue
    findings.push(finding(
      'multiple-dependent',
      number,
      'error',
      `所引用的权利要求 ${reference} 本身是多项从属权利要求，不得作为另一项多项从属权利要求引用的基础。`,
      clause,
    ))
  }

  if (!claim.independent) {
    for (const reference of claim.references) {
      const target = byNumber.get(reference)
      if (target === undefined) continue
      const own = claim.subject.replace(/\s+/g, '')
      const referenced = target.subject.replace(/\s+/g, '')
      if (own === '' || referenced === '' || own === referenced) continue
      const severity = own.includes(referenced) || referenced.includes(own) ? 'warning' : 'error'
      findings.push(finding(
        'subject-consistency',
        number,
        severity,
        `本项的主题名称为「${own}」，所引用的权利要求 ${reference} 为「${referenced}」；引用部分应当写明与独立权利要求一致的主题名称。`,
        clause,
      ))
    }

    const marker = LIMITATION_MARKER.exec(claim.text)
    if (marker === null) {
      findings.push(finding(
        'dependent-limitation',
        number,
        'warning',
        '从属权利要求未用「其特征在于」或「其中」引出限定部分。',
        claim.text.slice(0, 30),
      ))
    } else {
      const tail = claim.text
        .slice(marker.index + marker[0].length)
        .replace(/[。；，、\s]/g, '')
      if (tail === '') {
        findings.push(finding(
          'dependent-limitation',
          number,
          'error',
          '从属权利要求的限定部分为空；应当用附加技术特征对引用的权利要求作进一步限定。',
          claim.text.slice(marker.index),
        ))
      }
    }
  } else {
    const count = (claim.text.match(/其特征在于/g) ?? []).length
    if (count === 0) {
      findings.push(finding(
        'two-part-form',
        number,
        'warning',
        '独立权利要求没有「其特征在于」的分界；除必须用其他方式表达以外，应当包括前序部分和特征部分。',
        head,
      ))
    } else if (count > 1) {
      findings.push(finding(
        'two-part-form',
        number,
        'warning',
        `独立权利要求出现了 ${count} 处「其特征在于」；两部分式只应有一处分界。`,
        head,
      ))
    }
  }

  for (const { pattern, label } of FUNCTIONAL_PATTERNS) {
    findings.push(...scanPattern(
      number,
      characteristic,
      pattern,
      'functional-limitation',
      'warning',
      hit => `特征部分使用了${label}的功能或效果限定（「${hit}」）；实用新型应当尽量避免，改用结构特征限定。`,
    ))
  }
  findings.push(...scanPattern(
    number,
    characteristic,
    PROCESS_PATTERN,
    'process-feature',
    'warning',
    hit => `特征部分出现工艺方法特征「${hit}」；实用新型只保护形状、构造，工艺特征不产生保护作用。`,
  ))
  // 只查独立权利要求：从属项的主题名称读作「所述方法」，重复的是独权的主题，
  // 步骤顺序的声明应在独权中作出。
  const enumeratesSteps = STEP_LIST_PATTERN.test(characteristic)
  const declaresOrder = STEP_ORDER_PATTERN.test(characteristic)
  if (claim.independent && METHOD_SUBJECT_PATTERN.test(claim.subject) && enumeratesSteps && !declaresOrder) {
    findings.push(finding(
      'step-order',
      number,
      'warning',
      '方法权利要求以「包括步骤」列举操作，但未声明步骤顺序是否构成限定；写明「依次执行」或「可任意顺序执行」，避免侵权判定时对顺序限定的争议。',
      characteristic,
    ))
  }
  findings.push(...scanPattern(
    number,
    characteristic,
    NON_TECHNICAL_PATTERN,
    'non-technical-feature',
    'warning',
    hit => `特征部分出现不产生技术效果的内容「${hit}」。`,
  ))
  findings.push(...scanPattern(
    number,
    characteristic,
    COMMERCIAL_PATTERN,
    'commercial-language',
    'warning',
    hit => `特征部分出现商业性宣传或贬低性用语「${hit}」。`,
  ))
  findings.push(...scanPattern(
    number,
    characteristic,
    EXTERNAL_REFERENCE_PATTERN,
    'external-reference',
    'error',
    hit => `权利要求引用了说明书或附图（「${hit}」）；权利要求应当自身完整限定保护范围。`,
  ))

  const periods = claim.text.match(/。/g) ?? []
  if (periods.length === 0) {
    findings.push(finding('terminator', number, 'error', '本项没有以句号结尾。', claim.text.slice(-20)))
  } else if (periods.length > 1) {
    findings.push(finding(
      'terminator',
      number,
      'error',
      `本项出现了 ${periods.length} 个句号；每项权利要求仅允许在结尾处使用一个句号，分行分小段处只用分号或逗号。`,
      claim.text.slice(-20),
    ))
  } else if (!claim.text.endsWith('。')) {
    findings.push(finding('terminator', number, 'error', '句号出现在项内而非结尾处。', claim.text.slice(-20)))
  }

  for (const gap of findAntecedentGaps(claim.text, priorTextOf(claim, byNumber))) {
    findings.push(finding('antecedent-basis', number, gap.severity, gap.message, gap.evidence))
  }

  return findings
}

/**
 * 文档级规则：权利要求正文之外的内容与项数上限。
 * @param document - 解析结果。
 * @param options - lint 选项。
 * @returns 发现列表。
 */
function lintDocument(document: ParsedClaimDocument, options: ClaimLintOptions): ClaimLintFinding[] {
  const findings: ClaimLintFinding[] = []
  if (document.extraneous.length > 0) {
    const lines = document.extraneous.slice(0, 3).map(entry => `第 ${entry.line} 行「${entry.text.slice(0, 24)}」`)
    findings.push(finding(
      'non-claim-content',
      null,
      'error',
      `权利要求正文之外有 ${document.extraneous.length} 行内容；提交版本不得包含标题、说明文字、表格或分隔线。${lines.join('、')}。`,
      lines.join('、'),
    ))
  }
  const maxClaims = options.maxClaims
  if (maxClaims !== undefined && document.claims.length > maxClaims) {
    const lastNumber = document.claims.reduce((highest, claim) => Math.max(highest, claim.number), 0)
    findings.push(finding(
      'claim-count',
      null,
      'warning',
      `共 ${document.claims.length} 项权利要求，超过撰写约束的 ${maxClaims} 项上限。`,
      `权利要求 1–${lastNumber}`,
    ))
  }
  return findings
}

/**
 * 对权利要求书文本执行全部形式自检。
 * @param source - 权利要求书全文（markdown 或纯文本）。
 * @param options - lint 选项。
 * @returns 解析出的权利要求与全部发现。
 */
export function lintClaimText(source: string, options: ClaimLintOptions = {}): ClaimLintReport {
  const document = parseClaimDocument(source)
  const byNumber = new Map(document.claims.map(claim => [claim.number, claim]))
  const findings = [
    ...lintDocument(document, options),
    ...document.claims.flatMap((claim, index) => lintClaim(claim, index, byNumber)),
  ]
  const errorCount = findings.filter(entry => entry.severity === 'error').length
  return {
    claims: document.claims,
    findings,
    errorCount,
    warningCount: findings.length - errorCount,
    passed: errorCount === 0,
  }
}
