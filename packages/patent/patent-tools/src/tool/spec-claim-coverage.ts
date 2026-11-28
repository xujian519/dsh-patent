/**
 * Claim-feature coverage (A26.4), independent-claim unity (A31.1), and the
 * claim-to-embodiment coverage matrix.
 */

import {
  NUMERIC_ANY_UNIT_ALTERNATION,
  canonicalNumericUnit,
  checkClaimUnity,
  checkEmbodimentCoverage,
  type UnityClaim,
} from '@deepseek-ai/dsh-patent-core'
import type { SpecViolation, ValidateSpecificationInput } from './spec-types.ts'

const CLAIM_REF_PATTERN =
  /所述([\u4e00-\u9fa5A-Za-z0-9·\-]{2,24}?)(?=与|和|及|或|、|，|,|；|;|用于|包括|连接|设置|固定|安装|位于|设于|[。])/g

const CLAIM_VALUE_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${NUMERIC_ANY_UNIT_ALTERNATION})`, 'g')

/** Overly broad generic terms that do not participate in coverage comparison. */
const GENERIC_TERMS = new Set([
  '装置', '系统', '方法', '结构', '单元', '模块', '部件', '组件', '步骤', '特征',
  '技术', '方案', '本发明', '申请', '权利要求', '领域', '信息', '数据',
])

/** Claim feature candidates, split by how coverage finds them in the description. */
type ClaimFeatures = {
  /** `所述X` nouns, matched as substrings of the description. */
  terms: string[]
  /** `数值+单位` values, keyed by value and canonical unit so that 10mm and 10毫米 coincide. */
  values: string[]
}

/**
 * One matched value's coverage key: the number plus the canonical unit, so that
 * 10mm and 10毫米 produce the same key.
 * @param match - a {@link CLAIM_VALUE_PATTERN} match.
 * @returns the coverage key.
 */
function valueKey(match: RegExpExecArray): string {
  /* v8 ignore next -- both number and unit groups always participate in a match. */
  return `${match[1] ?? ''}${canonicalNumericUnit(match[2] ?? '')}`
}

/**
 * Technical-feature candidates of the claims, kept apart by match kind.
 * @param claims - the claims text.
 * @returns the term candidates and the numeric-value candidates.
 */
function claimFeatures(claims: string): ClaimFeatures {
  const terms = new Set<string>()
  let m: RegExpExecArray | null
  CLAIM_REF_PATTERN.lastIndex = 0
  while ((m = CLAIM_REF_PATTERN.exec(claims)) !== null) {
    /* v8 ignore next -- the lookahead pattern always captures the term group. */
    const term = (m[1] ?? '').trim()
    if (term.length >= 2 && !GENERIC_TERMS.has(term)) terms.add(term)
  }
  const values = new Set<string>()
  CLAIM_VALUE_PATTERN.lastIndex = 0
  while ((m = CLAIM_VALUE_PATTERN.exec(claims)) !== null) values.add(valueKey(m))
  return { terms: [...terms], values: [...values] }
}

/**
 * Extract technical-feature candidates from claims ("所述X" nouns + number-unit values).
 * @param claims - the claims text.
 * @returns the extracted feature candidates; numeric ones carry their canonical unit.
 */
export function extractClaimFeatures(claims: string): string[] {
  const { terms, values } = claimFeatures(claims)
  return [...terms, ...values]
}

/**
 * Claim features absent from the specification text.
 *
 * Numeric values compare by value and canonical unit rather than by substring, so
 * a description that writes 10毫米 covers a claim that writes 10mm. The unit is
 * not converted: 10cm does not cover 100mm, because that would hide a real
 * mismatch behind a silent arithmetic step.
 * @param claims - the claims text.
 * @param text - the specification text.
 * @returns the missing features and the total feature count.
 */
export function checkClaimCoverage(claims: string, text: string): { missing: string[]; total: number } {
  const { terms, values } = claimFeatures(claims)
  const textValues = new Set<string>()
  let m: RegExpExecArray | null
  CLAIM_VALUE_PATTERN.lastIndex = 0
  while ((m = CLAIM_VALUE_PATTERN.exec(text)) !== null) textValues.add(valueKey(m))
  const missing = [
    ...terms.filter(term => !text.includes(term)),
    ...values.filter(value => !textValues.has(value)),
  ]
  return { missing, total: terms.length + values.length }
}

/**
 * Independent-claim unity (A31.1) and the claim-to-embodiment coverage matrix.
 *
 * The coverage matrix is computed from the supplied features and embodiment
 * refs only; an entry whose claim id is invalid is reported instead of being
 * dropped, so the caller repairs the entry rather than reading a matrix that
 * silently omits that claim.
 * @param input - the specification input under validation.
 * @returns violations from both claim-set checks, in claim order.
 */
export function checkClaimSet(input: ValidateSpecificationInput): SpecViolation[] {
  const violations: SpecViolation[] = []
  const units = input.claim_units
  if (units !== undefined && units.length > 0) {
    const claims: UnityClaim[] = units.map(unit => ({
      number: unit.number,
      kind: unit.kind,
      preamble: unit.preamble,
      ...(unit.characterized === undefined ? {} : { characterized: unit.characterized }),
    }))
    const verdict = checkClaimUnity(claims)
    if (verdict.grade !== 'good') {
      // grade 不为 good 时必然存在配对：独立权利要求不足两项时评级恒为 good。
      const weakest = verdict.pairScores.reduce((left, right) => (right.similarity < left.similarity ? right : left))
      const pair = `独立权利要求 ${weakest.leftNumber} 与 ${weakest.rightNumber}`
      const similarity = `技术关联度 ${verdict.score.toFixed(1)}%（启发式相似度）`
      violations.push(
        verdict.grade === 'poor'
          ? {
            rule: 'claim_unity',
            family: 'claims',
            severity: 'error',
            section: '权利要求书',
            message: `${pair} 的${similarity}低于 60% 阈值，可能不满足单一性`,
            suggestion: '确认各独立权利要求是否包含相同或相应的特定技术特征（专利法第31条第1款）；否则分案申请或改写为从属权利要求',
          }
          : {
            rule: 'claim_unity',
            family: 'claims',
            severity: 'warning',
            section: '权利要求书',
            message: `${pair} 的${similarity}接近 60% 阈值，建议复核单一性`,
            suggestion: '补充共同的特定技术特征，避免审查中被要求分案',
          },
      )
    }
  }

  const entries = input.coverage_entries
  if (entries === undefined || entries.length === 0) return violations
  const matrix = checkEmbodimentCoverage(
    entries.map(entry => ({
      claimId: entry.claim_id,
      features: entry.features,
      embodimentRefs: entry.embodiment_refs,
    })),
    units?.length,
  )
  for (const item of matrix.items) {
    if (!item.valid) {
      violations.push({
        rule: 'claim_coverage_entry',
        family: 'claims',
        severity: 'error',
        section: '权利要求书',
        message: `覆盖条目 ${item.claimId} 不合法：${item.invalidReason}`,
        suggestion: '按 claim_<n> 提供条目编号与至少一项技术特征，n 取该申请已存在的权利要求编号',
      })
      continue
    }
    if (item.coverage === 'full') continue
    violations.push({
      rule: 'claim_embodiment_coverage',
      family: 'claims',
      severity: item.coverage === 'none' ? 'error' : 'warning',
      section: '具体实施方式',
      message: `权利要求 ${item.claimId} 的 ${item.uncovered.length}/${item.featureCount} 项特征未获实施例支持：${item.uncovered.join('、')}`,
      suggestion: '在具体实施方式中补充对应实施例，或删除未获支持的特征（A26.3/A26.4）',
    })
  }
  // 编号断档：内核只在条目编号全部合法时推断，故直接报出矩阵给出的 gaps，不自行补算。
  for (const gap of matrix.gaps) {
    violations.push({
      rule: 'claim_coverage_gap',
      family: 'claims',
      severity: 'warning',
      section: '权利要求书',
      message: `覆盖条目缺少权利要求 ${String(gap)}`,
      suggestion: '为每个权利要求各提供一条覆盖条目；该权项若已删除，同步调整权利要求书与条目',
    })
  }
  return violations
}
