/**
 * Anti-slop engine for patent text (ported from Sati's src/patent/slop-engine.ts,
 * itself ported from Mady domains/rules/slop_engine.go). Deterministic regex/count
 * logic: phrase cleanup, structure-issue detection, and a 43-point five-dimension
 * score. Consumers: the `patent_eval` tool's "表达质量" dimension and the
 * `slop-gate` atom (权利要求草稿与意见陈述书正文两侧共用同一套判据).
 *
 * 判据在两类文书上的共同点与差异都体现在这里：条数型口径（concision 的段数、
 * directness 的「前 200 字」、reason_pile 的引用次数、evidence 的段落数加分）在八节
 * 意见陈述书上会因文书结构本身而恒真或恒假，故分流为「有声明预算按预算」
 * 「按不同条款计数」「跳过抬头与标题找开头正文」三种口径，见各函数说明。
 * @module @deepseek-ai/dsh-patent-tools/internal/slop-engine
 */

import { runeSlice } from '@deepseek-ai/dsh-patent-core'

/** Rule groups the anti-slop phrase cleanup can act on. */
type SlopGroup =
  | 'filler' | 'qualifier' | 'passive' | 'meta' | 'advisory' | 'search' | 'intimacy' | 'subjectless'

/** One phrase-cleanup change (original → replacement, with its rule group). */
type SlopChange = { original: string; replacement: string; group: string }

/** Structure-issue category detected by the anti-slop engine. */
type StructureIssueType =
  | 'empty_three_step' | 'fake_comparison' | 'binary_turn' | 'reason_pile' | 'passive_voice' | 'oa_formula'

/** One detected structure issue with its location, text, and fix suggestion. */
type StructureIssue = { type: StructureIssueType; line: number; text: string; suggestion: string }

/** 反套话评分门通过线（43 分制及格线；SlopScore.passed 的唯一判定来源）。 */
export const SLOP_PASS_LINE = 35

/** Five-dimension 43-point anti-slop score. */
type SlopScore = {
  directness: number
  evidence: number
  rhythm: number
  practicality: number
  concision: number
  total: number
  passed: boolean
}

/** One anti-slop checklist question with its pass state and detail. */
type ChecklistItem = { question: string; passed: boolean; detail: string }

/** Full anti-slop analysis (cleaned text, changes, issues, score, checklist). */
export type SlopAnalysis = {
  cleaned: string
  changes: SlopChange[]
  issues: StructureIssue[]
  score: SlopScore
  checklist: ChecklistItem[]
}

type SlopRule = { pattern: RegExp; replacement: string; label: string; group: SlopGroup }

function mk(pattern: string, replacement: string, label: string, group: SlopGroup): SlopRule {
  return { pattern: new RegExp(pattern, 'g'), replacement, label, group }
}

/** Phrase-level rules (8 groups, 39 calibrated regexes). */
const PHRASE_RULES: SlopRule[] = [
  mk('进一步地[，,]?', '', '填充词「进一步地」', 'filler'),
  mk('此外[，,]?', '', '填充词「此外」', 'filler'),
  mk('值得一提的是[，,]?', '', '填充词「值得一提的是」', 'filler'),
  mk('不难发现[，,]?', '', '填充词「不难发现」', 'filler'),
  mk('毋庸置疑[，,]?', '', '填充词「毋庸置疑」', 'filler'),
  mk('需要指出的是[，,]?', '', '填充词「需要指出的是」', 'filler'),
  mk('综上所述[，,]?', '', '填充词「综上所述」', 'filler'),
  mk('诚如前述[，,]?', '', '填充词「诚如前述」', 'filler'),
  mk('显而易见地[，,]?', '', '空泛「显而易见地」', 'qualifier'),
  mk('本领域技术人员能够理解[，,]?', '', '空泛「本领域技术人员能够理解」', 'qualifier'),
  mk('创造性得以确立[。.]?', '', '空泛「创造性得以确立」', 'qualifier'),
  mk('保护范围合理[。.]?', '', '空泛「保护范围合理」', 'qualifier'),
  mk('具有显著进步[。.]?', '', '空泛「具有显著进步」', 'qualifier'),
  mk('质的飞跃[。.]?', '', '空泛「质的飞跃」', 'qualifier'),
  mk('革命性', '', '夸张修饰「革命性」', 'qualifier'),
  mk('颠覆性', '', '夸张修饰「颠覆性」', 'qualifier'),
  mk('深入[地]?分析', '分析', '空洞修饰「深入分析」', 'qualifier'),
  mk('全面[地]?论述', '论述', '空洞修饰「全面论述」', 'qualifier'),
  mk('系统[地]?(分析|论述|阐述)', '$1', '空洞修饰「系统化」', 'qualifier'),
  mk('一体化', '', '空洞修饰「一体化」', 'qualifier'),
  mk('新颖性是指[^，。]*[，。]?', '', '科普腔「新颖性定义」', 'qualifier'),
  mk('创造性判断(通常)?采用三步法[，。]?', '', '科普腔「三步法介绍」', 'qualifier'),
  mk('正如大家所知[，,]?', '', '顾问腔「正如大家所知」', 'qualifier'),
  mk('下文将分[一二三四五六七八九十]+部分[^，。]*[，。]?', '', '元叙述「下文将分部分」', 'meta'),
  mk('首先分析[^，。]*，再分析[^，。]*[。]?', '', '元叙述「首先…再…」', 'meta'),
  mk('恕我直言[，,]?', '', '虚假亲密「恕我直言」', 'intimacy'),
  mk('请允许我指出[，,]?', '', '虚假亲密「请允许我指出」', 'intimacy'),
  mk('这是一个值得深思的问题[。.]?', '', '表演强调「值得深思的问题」', 'intimacy'),
  mk('创造性障碍得以克服[。.]?', '', '无主句「创造性障碍得以克服」', 'subjectless'),
  mk('审查意见所指缺陷得以消除[。.]?', '', '无主句「缺陷得以消除」', 'subjectless'),
  mk('现有技术给出了启示[。.]?', '', '无主句「现有技术给出了启示」', 'subjectless'),
  mk('创造性得以认可[。.]?', '', '无主句「创造性得以认可」', 'subjectless'),
  mk('保护范围得以[^，。]*界定[。.]?', '', '无主句「保护范围得以…界定」', 'subjectless'),
  mk('审查实践认为[^，。]*[。.]?', '', '无主句「审查实践认为」', 'subjectless'),
  mk('检索范围广泛[，,]?结果丰富[。.]?', '', '检索空话「范围广泛结果丰富」', 'search'),
  mk('高相关文献若干[。.]?', '', '检索空话「高相关文献若干」', 'search'),
  mk('建议继续检索[。.]?', '', '检索空话「建议继续检索」', 'search'),
  mk('以上分析仅供参考[，,]不构成法律意见', '以上分析仅供参考。', '免责堆叠「仅供参考不构成法律意见」', 'advisory'),
  mk('存在不确定性[，,]结果可能因审查实践而异', '', '免责堆叠「存在不确定性」', 'advisory'),
]

const RE_EMPTY_THREE_STEP = /区别特征/
const RE_FAKE_COMPARISON = /\|.*特征.*\|/
const RE_HAS_PARAGRAPH = /¶\d{3,4}/
const RE_HAS_YEAR_REF = /\[\d{4}\]/
const RE_BINARY_TURN = /不是[^，]{2,20}问题[，,]\s*而是/
const RE_PASSIVE_VOICE = /被(驳回|认定为|视为|公开).*[。.]/
const RE_OA_FORMULA = /(审查员认定有误|审查员之意见|请审查员重新考虑)/
const RE_REASON_PILE = /第[\d一二三四五六七八九十]+条/g
const RE_MAIN_POINT = /(争点|问题|争议|焦点|核心|异议|驳回)/
const RE_EVIDENCE = /(D\d|权[\d]|第[\d]条|段落)/
const RE_PARAGRAPH_REF = /¶\d{3,4}/
const RE_EXAGGERATION = /(显著|突出|质的飞跃|革命性|颠覆性)/
const RE_SEARCH_TERMS = /(去重|命中|数据库)/

/**
 * 证据锚点：能把一句话落到具体记载的标记——对比文件编号、段落号、权项号、法条、
 * 事实编号或节次回指。有锚点的句子不是「假三步法」，即便它用冒号引出定义。
 */
const RE_EVIDENCE_ANCHOR =
  /(D\s?\d|¶\s?\d|\[\d{3,4}\]|权利要求\s*\d|权\s?\d|第\s*[\d.]+\s*[条节款项]|[FP]\s?\d|对比文件\s*\d|见\s*\d+(?:\.\d+)*\s*节)/

/** 被动句之前出现的施事主体；写了主体就不是「隐藏主体」。 */
const RE_PASSIVE_ACTOR = /(申请人|审查员|审查意见|法院|合议组|对比文件|D\s?\d|[FP]\s?\d)/

/** 著录项字段（申请号/发明名称/答复对象…）：出现在行首附近即视为抬头行。 */
const RE_BIBLIO_FIELD = /(申请号|申请日|发明名称|申请人|专利号|答复编号|答复对象|案件编号)\s*[:：]/

/** 抬头行判定：著录项字段出现在行内前 40 字（Markdown 的 `**申请号：**` 与 HTML 的抬头同吃）。 */
const BIBLIO_FIELD_WINDOW = 40

/** 结构性行：标题与表格分隔行不是散文，逐行扫描不应对其判定。 */
const RE_STRUCTURAL_LINE = /^(?:#{1,6}\s|<h[1-6]|<\/?(?:section|div|table|tr|ul|ol|blockquote)\b)/i
const RE_RULE_ORNAMENT = /^\|?[\s:|-]+\|?$/

/** 预算扣分档（相对预算的篇幅比 → 该维度得分）。 */
const CONCISION_BANDS: readonly { maxRatio: number; score: number }[] = [
  { maxRatio: 1, score: 8 },
  { maxRatio: 1.25, score: 6 },
  { maxRatio: 1.5, score: 4 },
]

/** evidence 维度的中性基线分（有锚点再加分）。 */
const EVIDENCE_BASELINE = 5

/**
 * 声明预算的文书中，全文零证据锚点时的 evidence 上限。
 *
 * 基线 5 分是为「短草稿」留的中性值：权项草稿可以只写特征不引文献。但一份声明了
 * 篇幅预算的意见陈述书通篇不引对比文件、权项或法条，等于没有任何证据支撑——这类
 * 文本正是「申请人恳请审查员重新考虑…综上所述」式的套话答复，不能靠基线分通过。
 */
const EVIDENCE_NO_ANCHOR_CAP = 4

/** Length in Unicode code points (aligns Go rune semantics). */
function runeLen(s: string): number {
  return Array.from(s).length
}

/** 剔除样式表、脚本、注释与全部标签（它们的字符不属于交付文本）。 */
function stripMarkup(text: string): string {
  return text
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
}

/** 修改后独立权利要求全文的标题（`conventions.md` §6 要求全文呈现，§10 明确不计入篇幅）。 */
const RE_CLAIM_FULLTEXT_HEADING = /^#{1,6}\s.*(?:修改后的独立权利要求|修改后的权利要求全文)/

/** 单行是否 Markdown 表格行（以竖线开头）：表格是交付载体，不是散文。 */
const RE_MD_TABLE_ROW = /^\s*\|/

/**
 * 剔除「载体」块：表格与「修改后的独立权利要求」全文。
 *
 * `conventions.md` §10 的篇幅口径是「不含表格与权利要求全文」，而表格与权项全文
 * 是交付载体（表 1/2/3、2.1 全文），它们的字数是体例要求带来的、不能靠删减压掉。
 * 2026-10-31 用真实草稿核对时发现旧实现只剔标记、把表格文字算了进去：同一份草稿
 * 2892 字里有 987 字是表格（34%），于是「超预算」的判定把三张表的体例成本算在
 * 散文头上，`tighten` 也被指向删表——这条口径与 `checklist.md`、模板 `SKILL.md`
 * 的说法互相矛盾，故在此对齐到规范一侧。
 *
 * HTML 侧按标签与 `claim-text` 类剔除；Markdown 侧按表格行与「修改后的独立权利要求」
 * 标题所在的整节剔除（同级或更高级标题为止，与 `patent-document` 的章节折叠同一判法）。
 * @param text - 待计量的文本（HTML 或 Markdown）。
 * @returns 去掉载体块后的文本。
 */
function stripCarriers(text: string): string {
  const withoutHtml = text
    .replace(/<table[^>]*>[\s\S]*?<\/table>/gi, '')
    .replace(
      /<(div|p|section|blockquote)[^>]*\bclass=["'][^"']*\bclaim-text\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
      '',
    )
  const kept: string[] = []
  let skipLevel = 0
  for (const line of withoutHtml.split('\n')) {
    const trimmed = line.trim()
    const level = /^(#{1,6})\s/.exec(trimmed)?.[1]?.length ?? 0
    if (skipLevel > 0) {
      // 同级或更高级标题结束该节；更深层标题仍属本节正文。
      if (level > 0 && level <= skipLevel) skipLevel = 0
      else continue
    }
    if (level > 0 && RE_CLAIM_FULLTEXT_HEADING.test(trimmed)) {
      skipLevel = level
      continue
    }
    if (RE_MD_TABLE_ROW.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * 可见字符数：剔除载体块（表格、修改后独权全文）、标记、Markdown 记号与全部空白后按码点计。
 *
 * 与 `patent-core` 的 `visibleChars`（草案槽位配额）同一口径；本包不依赖
 * `patent-document`，故在此复写，改动须两处同步。`tighten` 原子也用它核对
 * 删减后的字数，故导出——预算口径只此一处，不得在别处另写一份。
 *
 * 载体块的剔除见 {@link stripCarriers}：规范说「不含表格与权利要求全文」，实现若把
 * 它们算进去，同一份稿子会同时得到「已在预算内」与「超预算 987 字」两种结论。
 * @param text - 待计量的文本（HTML 或 Markdown）。
 * @returns 可见字符数。
 */
export function visibleChars(text: string): number {
  return runeLen(stripMarkup(stripCarriers(text)).replace(/[*_`#>|~]/g, '').replace(/\s/g, ''))
}

/**
 * 取文书开头的正文，跳过标题、抬头著录项、引用块与纯标记行。
 *
 * 意见陈述书的第一段永远是「申请号/发明名称」抬头，用「前 200 字」判 directness
 * 会把每一份合规答复都判成「没点明争点」——这也是条数型口径在长文书上失真的
 * 同一类问题。先剔除标记再逐行筛，HTML 与 Markdown 两种交付形态走同一条路径。
 * @param text - 待分析的文本。
 * @returns 开头正文（至多 200 码点）。
 */
function openingProse(text: string): string {
  const kept: string[] = []
  for (const line of stripMarkup(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (RE_STRUCTURAL_LINE.test(trimmed)) continue
    if (trimmed.startsWith('>')) continue
    if (RE_RULE_ORNAMENT.test(trimmed)) continue
    const field = RE_BIBLIO_FIELD.exec(trimmed)
    if (field !== null && field.index <= BIBLIO_FIELD_WINDOW) continue
    kept.push(trimmed)
    if (runeLen(kept.join('')) >= 400) break
  }
  return runeSlice(kept.join(''), 200)
}

/** Structure-issue detection (line scan + whole-text reason count). */
function detectStructureIssues(text: string): StructureIssue[] {
  const lines = text.split('\n')
  const issues: StructureIssue[] = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (RE_STRUCTURAL_LINE.test(trimmed) || RE_RULE_ORNAMENT.test(trimmed)) return
    if (RE_EMPTY_THREE_STEP.test(line) && !RE_EVIDENCE_ANCHOR.test(line)) {
      issues.push({ type: 'empty_three_step', line: i + 1, text: runeSlice(trimmed, 80), suggestion: '区别特征应指向对比文件具体段落：D1¶[段落号]：特征详情' })
    }
    if (RE_FAKE_COMPARISON.test(line) && !RE_HAS_PARAGRAPH.test(line) && !RE_HAS_YEAR_REF.test(line)) {
      issues.push({ type: 'fake_comparison', line: i + 1, text: runeSlice(trimmed, 80), suggestion: '对比表每格应含对比文件段落号：D1¶0123' })
    }
    if (RE_BINARY_TURN.test(line)) {
      issues.push({ type: 'binary_turn', line: i + 1, text: runeSlice(trimmed, 80), suggestion: '直接写结论及证据，不用「不是X而是Y」转折' })
    }
    const passive = RE_PASSIVE_VOICE.exec(line)
    if (passive !== null && !RE_PASSIVE_ACTOR.test(line.slice(0, passive.index))) {
      issues.push({ type: 'passive_voice', line: i + 1, text: runeSlice(trimmed, 80), suggestion: '写明主体：审查员驳回… / 对比文件D1公开…' })
    }
    if (RE_OA_FORMULA.test(line)) {
      issues.push({ type: 'oa_formula', line: i + 1, text: runeSlice(trimmed, 80), suggestion: '直接写争点+法条+对比文件段落+修改对照' })
    }
  })
  // 按**不同条款**计数：同一法条在八节里被引用十次仍是一条理由，重复引用不是
  // 「理由堆积」。答复正文逐节引用 22.3/33/26.3 属正常写法。
  const provisions = new Set((text.match(RE_REASON_PILE) ?? []).map(provision => provision.replace(/\s/g, '')))
  if (provisions.size >= 4) {
    issues.push({ type: 'reason_pile', line: 1, text: `全文引用 ${provisions.size} 条不同条款`, suggestion: '主理由至多2条，其余删除或并入脚注' })
  }
  return issues
}

function scoreRhythm(issueCount: number): number {
  if (issueCount > 3) return 4
  if (issueCount > 1) return 6
  return 8
}

function scorePracticality(changeCount: number): number {
  if (changeCount > 5) return 5
  if (changeCount > 2) return 7
  return 9
}

/**
 * 精简度：篇幅只与**声明预算**比，不与段数比。
 *
 * 旧口径「段数 > 15 → 5 分」对八节意见陈述书是常数惩罚：任何合规答复都必然超过
 * 15 段，于是这一维永远扣 3 分，门永远红。改为按调用方声明的字数预算归一后，
 * 同样长度的文书在预算内不扣分、超出 25%/50% 分档扣分。
 *
 * 未声明预算（撰写链路的权项草稿）时沿用段数口径：权项草稿的段数本身就近似篇幅，
 * 且该链路没有声明预算的调用方，改动它只会让既有读数无谓漂移。
 * @param text - 待评分文本。
 * @param charBudget - 声明篇幅预算（可见字符）；缺省走段数口径。
 * @returns 该维度得分（8 / 6 / 4 / 3 或旧口径的 8 / 5）。
 */
function scoreConcision(text: string, charBudget: number | undefined): number {
  if (charBudget === undefined) return text.split('\n\n').length > 15 ? 5 : 8
  const ratio = visibleChars(text) / charBudget
  return CONCISION_BANDS.find(band => ratio <= band.maxRatio)?.score ?? 3
}

/** 打分选项：声明篇幅预算后，concision 按预算归一而不是按段数。 */
type SlopScoreOptions = {
  /** 文书篇幅预算（可见字符）；缺省为 undefined，走撰写链路的段数口径。 */
  charBudget?: number
}

/**
 * directness：全文开头正文是否直接点明争点。
 *
 * 只判「开头正文」而不判前 200 码点，见 {@link openingProse}；开头若仍用
 * 「请审查员重新考虑」这类套话请求式表述，即便顺带提到争点也不满分——这正是
 * oa_formula 要拦的那句话，它出现在第一段就说明整篇是在「请愿」而不是在论证。
 * @param text - 待评分文本。
 * @returns 该维度得分（8 / 5 / 4）。
 */
function scoreDirectness(text: string): number {
  const opening = openingProse(text)
  if (!RE_MAIN_POINT.test(opening)) return 4
  return RE_OA_FORMULA.test(opening) ? 5 : 8
}

/**
 * evidence：文本可核验到什么程度。
 *
 * 「段落少于 3 段加分」是短草稿口径（草稿短说明没注水），对按预算计量的意见陈述书
 * 是反向激励：把答复写短反而加分。故只在未声明预算时保留；声明预算时，全文零锚点
 * 直接压到 {@link EVIDENCE_NO_ANCHOR_CAP}。
 * @param text - 待评分文本。
 * @param charBudget - 声明的篇幅预算。
 * @returns 该维度得分（0-9）。
 */
function scoreEvidence(text: string, charBudget: number | undefined): number {
  const quoted = RE_EVIDENCE.test(text)
  let evidenceScore = EVIDENCE_BASELINE
  if (quoted) evidenceScore += 2
  if (RE_PARAGRAPH_REF.test(text)) evidenceScore += 2
  if (charBudget === undefined) {
    if (text.split('\n\n').length < 3) evidenceScore += 1
  } else if (!quoted) {
    evidenceScore = Math.min(evidenceScore, EVIDENCE_NO_ANCHOR_CAP)
  }
  return evidenceScore
}

/**
 * 43-point five-dimension score (directness 8 / evidence 10 / rhythm 8 / practicality 9 / concision 8).
 * @param text - 待评分文本。
 * @param changes - 短语清理命中。
 * @param issues - 结构性问题。
 * @param charBudget - 声明的篇幅预算。
 * @returns 五维得分与通过标记。
 */
function scoreDocument(
  text: string,
  changes: SlopChange[],
  issues: StructureIssue[],
  charBudget: number | undefined,
): SlopScore {
  const directness = scoreDirectness(text)
  const evidenceScore = scoreEvidence(text, charBudget)
  const rhythm = scoreRhythm(issues.length)
  const practicality = scorePracticality(changes.length)
  const concision = scoreConcision(text, charBudget)
  const total = directness + evidenceScore + rhythm + practicality + concision
  return { directness, evidence: evidenceScore, rhythm, practicality, concision, total, passed: total >= SLOP_PASS_LINE }
}

function hasIssueType(issues: StructureIssue[], type: StructureIssueType): boolean {
  return issues.some(issue => issue.type === type)
}

function buildIssueDetail(issues: StructureIssue[], type: StructureIssueType, label: string): string {
  const count = issues.filter(issue => issue.type === type).length
  return count > 0 ? `${count} 处${label}` : '无'
}

function runChecklist(text: string, issues: StructureIssue[]): ChecklistItem[] {
  const snippet = runeSlice(text, 500)
  const hasFeature = snippet.includes('特征')
  const hasEvidenceMarker = snippet.includes('权') || /D\d/.test(snippet) || snippet.includes('¶')
  const featurePassed = !hasFeature || hasEvidenceMarker
  return [
    { question: '有无未指向权项号或对比文件段落的特征论述？', passed: featurePassed, detail: '检查前500字中孤立出现的「特征」' },
    { question: '有无被动句隐藏主体（「被认为」「得以」「得以克服」）？', passed: !hasIssueType(issues, 'passive_voice'), detail: buildIssueDetail(issues, 'passive_voice', '被动句') },
    { question: '创造性段落是否仅有「区别特征+技术问题+显而易见」标题而无D1映射？', passed: !hasIssueType(issues, 'empty_three_step'), detail: buildIssueDetail(issues, 'empty_three_step', '假三步法') },
    { question: '是否出现「不是X问题，而是Y问题」式假转折？', passed: !hasIssueType(issues, 'binary_turn'), detail: buildIssueDetail(issues, 'binary_turn', '假转折') },
    { question: '无效理由是否超过3条且彼此无优先级？', passed: !hasIssueType(issues, 'reason_pile'), detail: buildIssueDetail(issues, 'reason_pile', '理由超量') },
    { question: '是否用「显著」「突出」「质的飞跃」而无实验数据或对比效果？', passed: !RE_EXAGGERATION.test(text), detail: '含无数据夸张修饰' },
    { question: '说明书「技术效果」是否与权利要求特征逐项对应？', passed: true, detail: '需人工确认' },
    { question: '检索报告是否有命中逻辑与去重说明？', passed: RE_SEARCH_TERMS.test(text) || runeLen(text) < 500, detail: RE_SEARCH_TERMS.test(text) ? '有' : 'N/A（非检索报告）' },
  ]
}

/**
 * Three-layer full analysis: phrase cleanup → structure issues → score + checklist.
 * @param text - the patent text to analyze.
 * @param options - 评分选项；声明 `charBudget` 后 concision 按预算归一。
 * @returns the cleanup, changes, issues, score, and checklist.
 */
export function analyzeSlop(text: string, options: SlopScoreOptions = {}): SlopAnalysis {
  const changes: SlopChange[] = []
  let cleaned = text
  for (const rule of PHRASE_RULES) {
    const before = cleaned
    cleaned = cleaned.replace(rule.pattern, rule.replacement)
    if (cleaned !== before) {
      changes.push({ original: rule.label, replacement: rule.replacement === '' ? '（删除）' : rule.replacement, group: rule.group })
    }
  }
  cleaned = cleaned.replace(/[ \t\n]+$/, '') + '\n'
  const issues = detectStructureIssues(cleaned)
  const score = scoreDocument(text, changes, issues, options.charBudget)
  const checklist = runChecklist(text, issues)
  return { cleaned, changes, issues, score, checklist }
}
