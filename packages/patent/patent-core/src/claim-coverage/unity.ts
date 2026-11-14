/**
 * src/patent/claim-coverage — 单一性判定（专利法第31条第1款、专利法实施细则第39条）。
 * 专利法第31条第2款的外观设计合案不在本判定中。
 *
 * 一件申请中的多项独立权利要求，应包含"相同或相应的特定技术特征"才满足单一性。
 * 本模块对独立权利要求逐对比较：先清洗结构样板词（"一种""包括""其特征在于"等），
 * 再按字符重叠 0.2 + Jaccard 0.5 + Bigram 余弦 0.3 的加权相似度取**最弱对**
 * （短板原则）作为整体技术关联度，评分即最弱对相似度的百分数。
 *
 * 相似度阈值 0.6 与权重来自上游 Sati `unity.yaml` 规范，是启发式口径而非法条数值：
 * 结论用于撰写自检，最终单一性判断仍须由代理师作出，报告中不出现确定性的法律结论。
 * 三条评级线与判定阈值因此自洽：低于 0.6 为 poor（不满足单一性），0.6-0.8 为 fair，
 * 不低于 0.8 为 good。
 *
 * 与上游的差异：上游按 `60 + 40 × 最弱对相似度` 折算评分，使 fair 分支不可达
 * （相似度达 0.6 阈值时评分恒 ≥84），且"存在低于阈值对"的 poor 可与 ≥80 分并存。
 * 本模块改用相似度百分数，使评分、评级与单一性判定三者一致。
 *
 * 对照：本模块判定**多项独立权利要求之间**的单一性；权项特征是否得到实施例支持
 * 属 A26.4，见同目录 coverage.ts。
 */

/** 权利要求的类型：独立权利要求参与单一性比较，从属权利要求不参与。 */
export type ClaimKind = 'independent' | 'dependent'

/** 参与单一性比较的权利要求（调用方给出前序部分与特征部分）。 */
export type UnityClaim = {
  /** 权利要求编号（用于报告配对，不参与相似度计算）。 */
  number: number
  kind: ClaimKind
  /** 前序部分，如"一种智能门锁"。 */
  preamble: string
  /** 特征部分（"其特征在于"之后的内容）。 */
  characterized?: string
}

/** 单一性评级：good（≥0.8）/ fair（≥0.6 且低于 0.8）/ poor（存在低于阈值的权利要求对）。 */
export type ClaimUnityGrade = 'good' | 'fair' | 'poor'

/** 一对独立权利要求的相似度。 */
export type ClaimUnityPair = {
  leftNumber: number
  rightNumber: number
  similarity: number
}

/** 单一性判定结果。 */
export type ClaimUnityVerdict = {
  /** 是否存在低于阈值的独立权利要求对。 */
  hasUnity: boolean
  /** 评分 0-100：最弱独立权利要求对的相似度百分数；无配对可比较时为 100。 */
  score: number
  grade: ClaimUnityGrade
  pairScores: ClaimUnityPair[]
  diagnostics: string[]
}

/** 特征对应判定阈值：相似度不低于该值视为存在相同或相应的特定技术特征。 */
const UNITY_SIMILARITY_THRESHOLD = 0.6
/** 评级良好线：不低于该相似度即评为 good。 */
const UNITY_SIMILARITY_GOOD = 0.8
/** 无配对可比较（独立权利要求不足两项）时的评分：不存在单一性风险。 */
const UNITY_SCORE_NO_PAIRS = 100
/** 字符重叠权重。 */
const UNITY_CHAR_OVERLAP_WEIGHT = 0.2
/** Jaccard 权重。 */
const UNITY_JACCARD_WEIGHT = 0.5
/** Bigram 余弦权重。 */
const UNITY_BIGRAM_WEIGHT = 0.3

const LOW_SIMILARITY_DIAGNOSTIC =
  '存在独立权利要求对的特征相似度低于 0.6，未发现相同或相应的特定技术特征，可能不满足单一性要求'
/**
 * 结构/语法样板词：不参与"特定技术特征"相似度比较。
 *
 * "由…组成" 的省略号写法无法命中真实文本，收敛为字面 "组成"。
 */
const UNITY_STOP_WORDS: readonly string[] = [
  '一种', '所述', '其特征在于', '包括', '包含', '组成',
  '和', '及', '与', '或', '的', '之', '该', '其', '等',
  '用于', '按照', '根据', '至少',
]

const UNITY_STRIPPED_PUNCTUATION = new Set([
  ' ', '，', '；', '。', '、', '：', ',', ';', '.', ':',
  '（', '）', '(', ')', '\n', '\t', '"', '\'', '“', '”', '‘', '’',
])

/**
 * 检查多项独立权利要求之间的单一性。
 *
 * 独立权利要求少于两项时视为天然满足单一性（评分取良好线，不产生配对）。
 * @param claims - 参与判定的权利要求（从属权利要求被忽略）。
 * @returns 单一性判定结果。
 */
export function checkClaimUnity(claims: readonly UnityClaim[]): ClaimUnityVerdict {
  const independent = claims.filter(claim => claim.kind === 'independent')
  if (independent.length < 2) {
    return {
      hasUnity: true,
      score: UNITY_SCORE_NO_PAIRS,
      grade: 'good',
      pairScores: [],
      diagnostics: [],
    }
  }

  const verdict: ClaimUnityVerdict = {
    hasUnity: true,
    score: UNITY_SCORE_NO_PAIRS,
    grade: 'good',
    pairScores: [],
    diagnostics: [],
  }

  let weakest = 1
  for (const [index, left] of independent.entries()) {
    const leftText = `${left.preamble} ${left.characterized ?? ''}`
    for (const right of independent.slice(index + 1)) {
      const similarity = claimSimilarity(leftText, `${right.preamble} ${right.characterized ?? ''}`)
      verdict.pairScores.push({
        leftNumber: left.number,
        rightNumber: right.number,
        similarity,
      })
      if (similarity < weakest) weakest = similarity
    }
  }

  verdict.score = weakest * 100
  if (weakest < UNITY_SIMILARITY_THRESHOLD) {
    verdict.hasUnity = false
    verdict.grade = 'poor'
    verdict.diagnostics.push(LOW_SIMILARITY_DIAGNOSTIC)
  } else if (weakest >= UNITY_SIMILARITY_GOOD) {
    verdict.grade = 'good'
  } else {
    verdict.grade = 'fair'
  }
  return verdict
}

/**
 * 两段权利要求文本的特征相似度：清洗样板词后按字符重叠/Jaccard/Bigram 余弦加权。
 * @param left - 第一段文本。
 * @param right - 第二段文本。
 * @returns 0-1 的相似度；任一侧清洗后为空时返回 0。
 */
export function claimSimilarity(left: string, right: string): number {
  const a = codePoints(normalizeClaimText(left))
  const b = codePoints(normalizeClaimText(right))
  if (a.length === 0 || b.length === 0) return 0
  return (
    UNITY_CHAR_OVERLAP_WEIGHT * charOverlap(a, b)
    + UNITY_JACCARD_WEIGHT * jaccardSimilarity(a, b)
    + UNITY_BIGRAM_WEIGHT * bigramCosine(a, b)
  )
}

/**
 * 文本 → 码点数组。
 *
 * 上游 Go 按 rune（码点）比较，`for...of` 与 `[...text]` 同为码点迭代，此处不用展开
 * 写法以免被 `no-misused-spread` 判为意图按字形簇拆分。
 * @param text - 待拆分的文本。
 * @returns 码点数组。
 */
function codePoints(text: string): string[] {
  const points: string[] = []
  for (const char of text) points.push(char)
  return points
}

/**
 * 清洗权利要求文本：去除标点、空白与结构样板词，保留技术词汇。
 * @param text - 权利要求文本。
 * @returns 清洗后的文本。
 */
export function normalizeClaimText(text: string): string {
  let out = ''
  for (const char of text) {
    if (!UNITY_STRIPPED_PUNCTUATION.has(char)) out += char
  }
  for (const word of UNITY_STOP_WORDS) {
    out = out.replaceAll(word, '')
  }
  return out
}

function codePointSet(chars: readonly string[]): Set<string> {
  return new Set(chars)
}

function countIntersection(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0
  for (const char of left) {
    if (right.has(char)) intersection++
  }
  return intersection
}

/** 字符重叠率：交集大小 / 较小集合大小（调用方保证两侧非空）。 */
function charOverlap(a: readonly string[], b: readonly string[]): number {
  const setA = codePointSet(a)
  const setB = codePointSet(b)
  return countIntersection(setA, setB) / Math.min(setA.size, setB.size)
}

/** Jaccard 系数：交集大小 / 并集大小（调用方保证两侧非空）。 */
function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = codePointSet(a)
  const setB = codePointSet(b)
  const intersection = countIntersection(setA, setB)
  return intersection / (setA.size + setB.size - intersection)
}

function bigramCounts(chars: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = `${chars[i]}${chars[i + 1]}`
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Bigram 余弦相似度；清洗后不足两个字时无 bigram，返回 0。 */
function bigramCosine(a: readonly string[], b: readonly string[]): number {
  const countsA = bigramCounts(a)
  const countsB = bigramCounts(b)
  if (countsA.size === 0 || countsB.size === 0) return 0
  let dot = 0
  for (const [gram, countA] of countsA) {
    dot += countA * (countsB.get(gram) ?? 0)
  }
  let magnitudeA = 0
  for (const count of countsA.values()) magnitudeA += count * count
  let magnitudeB = 0
  for (const count of countsB.values()) magnitudeB += count * count
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB))
}
